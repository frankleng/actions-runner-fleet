#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseRegistry, parseServiceStatusOutput } from '../lib/runnerctl-core.mjs';
import { AutoscaleError, validateConfig, githubClient, snapshot, hostSample, plan, cpuPolicy, effectiveQuota } from '../lib/runnerctl-autoscale.mjs';

import { acquireControllerLock, configureController, boundControllerLog } from '../lib/runnerctl-autoscale-service.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: runnerctl autoscale [--config FILE] [--dry-run] [--once] [--prepare] [--enable|--disable]
Defaults: autoscale.json, continuous autoscaling with changes enabled.
--dry-run previews one poll; add --watch to keep previewing. --once applies one poll.
--prepare provisions slots and enables the background controller by default.
--prepare --no-enable provisions only. --enable/--disable manage controller startup.
Existing persistent runners are never converted or stopped. Configuration and state stay local.
Output contains aggregate counts only. CPU quota: 100% equals one logical CPU.
See README for authentication, ephemeral runner setup, and private configuration.`);
  process.exit(0);
}
let configPath = path.join(root, 'autoscale.json');
let watch = true;
let apply = true;
let dryRun = false;
let onceOnly = false;
let enable = false;
let disable = false;
let noEnable = false;
let configureAfter = false;
let prepare = false;
let releaseLock;
let quitting = false;
let sleeper;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' && args[i + 1]) configPath = path.resolve(args[++i]);
  else if (args[i] === '--watch') watch = true;
  else if (args[i] === '--apply') apply = true;
  else if (args[i] === '--prepare') prepare = true;
  else if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--once') onceOnly = true;
  else if (args[i] === '--enable') enable = true;
  else if (args[i] === '--disable') disable = true;
  else if (args[i] === '--no-enable') noEnable = true;
  else { console.error('Invalid arguments; use --help'); process.exit(1); }
}
if (prepare || enable || disable) { watch = false; apply = false; }
else if (dryRun) { apply = false; watch = args.includes('--watch'); }
if (onceOnly) watch = false;

// Service scripts must not inherit the controller's GitHub token (or other ambient secrets).
const serviceEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG',
  'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_CONFIG_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
async function command(file, commandArgs, cwd = root, timeout = 60000) {
  if (timeout === 0) {
    // Provisioners can emit unbounded output; avoid execFile's buffer kill.
    return await new Promise((resolve, reject) => {
      const child = spawn(file, commandArgs, { cwd, env: serviceEnv, stdio: 'ignore' });
      child.once('error', () => reject(new AutoscaleError('Local provisioning failed')));
      child.once('close', code => code === 0 ? resolve({ stdout: '' }) : reject(new AutoscaleError('Local provisioning failed; rerun --prepare to resume')));
    });
  }
  try { return await exec(file, commandArgs, { cwd, env: serviceEnv, timeout, maxBuffer: 1024 * 1024 }); }
  catch { throw new AutoscaleError('Local runner operation failed; inspect the service locally'); }
}
let unitsChanged = false;
async function setQuota(r, quota) {
  const args = ['set-cpu-limit', String(quota)];
  if (process.platform === 'linux') args.push('--defer-reload');
  // A partial operation may have rendered its unit before failing.
  unitsChanged = true;
  await command('./svc.sh', args, r.directory);
  r.quota = quota;
}
async function flushUnits() {
  if (unitsChanged && process.platform === 'linux') await command('systemctl', ['--user', 'daemon-reload']);
  unitsChanged = false;
}
async function readJson(file, missing = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return missing; throw error; }
}
async function localRunners(c) {
  const registry = parseRegistry(await fs.readFile(path.join(root, 'runners.tsv'), 'utf8'));
  const result = new Map();
  for (const name of [...c.baselineRunners, ...c.runners]) {
    try {
    const matches = registry.filter(r => r.name === name);
    if (matches.length !== 1) throw new AutoscaleError('Configured slot missing or duplicated in local registry');
    const directory = path.resolve(matches[0].directory);
    const baseline = c.baselineRunners.includes(name);
    const metadata = await readJson(path.join(directory, baseline ? '.runner' : '.autoscale-slot.json'));
    if ((!baseline && metadata?.version !== 1) || metadata?.agentName !== name ||
        metadata.gitHubUrl?.replace(/\/+$/, '').toLowerCase() !== `https://github.com/${c.target}`.toLowerCase()) {
      throw new AutoscaleError('Use --prepare with new slot names; persistent runners cannot be autoscaled');
    }
    await fs.access(path.join(directory, '.service'));
    const { stdout } = await command('./svc.sh', ['status'], directory);
    const status = parseServiceStatusOutput(stdout);
    if (!['running', 'stopped'].includes(status)) throw new AutoscaleError('Slot service unavailable');
    let quota = Number((await fs.readFile(path.join(directory, '.cpu-quota'), 'utf8')).trim());
    if (!Number.isSafeInteger(quota) || quota < 1) throw new AutoscaleError('Slot CPU quota unavailable');
    if (process.platform === 'linux' && status === 'running') quota = effectiveQuota(stdout, quota);
    if (baseline) {
      result.set(name, { directory, running: status === 'running', quota, id: metadata.agentId, active: status === 'running', phase: 'baseline', baseline: true });
      continue;
    }
    const inflight = await readJson(path.join(directory, '.autoscale-inflight.json'));
    const request = await readJson(path.join(directory, '.autoscale-request.json'));
    const runner = await readJson(path.join(directory, '.runner'));
    const generation = await readJson(path.join(directory, '.autoscale-generation.json'));
    const phase = (await readJson(path.join(directory, '.autoscale-state.json'), { phase: 'ready' })).phase;
    if (!['running', 'ready', 'blocked'].includes(phase)) throw new AutoscaleError('Invalid slot state');
    if (phase === 'blocked' || await readJson(path.join(directory, '.autoscale-reservation.json'))) throw new AutoscaleError('Slot blocked; inspect its local lifecycle files');
    const active = !!inflight || !!request || !!runner || phase === 'running';
    if (active && status === 'stopped') throw new AutoscaleError('Active generation has no running service; manual recovery required');
    if (runner && runner.ephemeral !== true) throw new AutoscaleError('Persistent registration in an ephemeral slot');
    const id = runner?.agentId ?? (inflight || request ? JSON.parse((inflight || request)['.runner']).agentId : generation?.id);
    result.set(name, { directory, running: status === 'running', quota, id, active, phase });
    } catch {
      // Unknown slots consume capacity conservatively, but never receive commands.
      result.set(name, { active: true, phase: 'blocked', unavailable: true });
    }
  }
  return result;
}
async function publishGeneration(c, name, slot, api) {
  const file = leaf => path.join(slot.directory, leaf);
  // A failed/ambiguous POST leaves a reservation, never an automatic retry that
  // could create or replace a runner whose registration outcome is unknown.
  await fs.writeFile(file('.autoscale-reservation.json'), '{}', { mode: 0o600, flag: 'wx' });
  let files;
  try { files = await api.create(c, name); }
  catch (error) {
    error.registrationFailure = true;
    if (error.definiteRejection) await fs.unlink(file('.autoscale-reservation.json'));
    throw error;
  }
  await fs.writeFile(file('.autoscale-generation.json'), JSON.stringify({ id: JSON.parse(files['.runner']).agentId }), { mode: 0o600 });
  await fs.writeFile(file('.autoscale-request.tmp'), JSON.stringify(files), { mode: 0o600, flag: 'wx' });
  await fs.link(file('.autoscale-request.tmp'), file('.autoscale-request.json'));
  await fs.unlink(file('.autoscale-request.tmp'));
  await fs.unlink(file('.autoscale-reservation.json'));
}
let cachedToken;
async function token() {
  if (process.env.RUNNER_AUTOSCALE_TOKEN) return process.env.RUNNER_AUTOSCALE_TOKEN;
  const tokenFile = process.env.RUNNER_AUTOSCALE_TOKEN_FILE || path.join(root, '.autoscale-token');
  const stat = await fs.stat(tokenFile).catch(() => null);
  if (stat) {
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new AutoscaleError('Token file must be a regular file owned by this user with mode 0600');
    const value = (await fs.readFile(tokenFile, 'utf8')).trim();
    if (value) return value;
  }
  try {
    const { stdout } = await exec('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 15000, maxBuffer: 65536 });
    if (stdout.trim()) return (cachedToken = stdout.trim());
  } catch {}
  // gh reads a desktop keyring that locks when its daemon restarts; keep polling with the last good token.
  if (cachedToken) return cachedToken;
  throw new AutoscaleError('Set RUNNER_AUTOSCALE_TOKEN, RUNNER_AUTOSCALE_TOKEN_FILE, or authenticate gh for github.com');
}
process.on('SIGTERM', () => { quitting = true; sleeper?.abort(); });
process.on('SIGINT', () => { quitting = true; sleeper?.abort(); });
try {
  const initialRaw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  let c = validateConfig(initialRaw);
  if (!prepare && initialRaw.runners === undefined) throw new AutoscaleError('Run --prepare first to persist the generated slot list');
  if ([prepare, enable, disable].filter(Boolean).length > 1 ||
      ((prepare || enable || disable) && (dryRun || onceOnly || args.includes('--watch') || args.includes('--apply'))) ||
      (noEnable && !prepare) || (dryRun && args.includes('--apply'))) throw new AutoscaleError('Conflicting autoscale options');
  if (apply || prepare) {
    try { releaseLock = await acquireControllerLock(root); }
    catch { throw new AutoscaleError('Autoscaler lock exists or its local lock port is occupied; stop the other controller before --prepare'); }
  }
  if (prepare) {
    // Read all names before making changes; refuse persistent or foreign slots.
    let registry = [];
    try { registry = parseRegistry(await fs.readFile(path.join(root, 'runners.tsv'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of c.runners) {
      const matches = registry.filter(r => r.name === name);
      if (matches.length > 1) throw new AutoscaleError('Duplicate slot');
      if (matches.length) {
        const slot = await readJson(path.join(matches[0].directory, '.autoscale-slot.json'));
        if (slot?.version !== 1 || slot.agentName !== name || slot.gitHubUrl !== `https://github.com/${c.target}`) {
          throw new AutoscaleError('Use new slot names; existing persistent runners will not be modified');
        }
      }
    }
    if (initialRaw.runners === undefined) {
      // Pin identities before provisioning. Resizes change bounds, never drop
      // existing slots or invent unprepared capacity during a controller poll.
      await fs.writeFile(`${configPath}.tmp`, JSON.stringify({ ...initialRaw, runners: c.runners }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await fs.rename(`${configPath}.tmp`, configPath);
    }
    for (const name of c.runners) {
      if (quitting) break;
      if (!registry.some(r => r.name === name)) {
        console.log('Preparing ephemeral slot locally...');
        await command(path.join(root, 'manage-runners.sh'), ['prepare-autoscale', name, `https://github.com/${c.target}`], root, 0);
      } else {
        const directory = registry.find(r => r.name === name).directory;
        // A missing service means provisioning never completed. An installed
        // service may own work; ordinary --prepare must not reconcile it.
        const installed = await fs.access(path.join(directory, '.service')).then(() => true, () => false);
        if (!installed) {
          for (const leaf of ['.runner', '.autoscale-request.json', '.autoscale-inflight.json']) {
            if (await fs.access(path.join(directory, leaf)).then(() => true, () => false)) throw new AutoscaleError('Incomplete slot contains a generation; manual recovery required');
          }
          await command(path.join(root, 'manage-runners.sh'), ['reconcile', name], root, 0);
        }
      }
    }
    if (!quitting && process.platform === 'linux') {
      let linger = '';
      try { linger = (await command('loginctl', ['show-user', String(process.getuid()), '--property=Linger', '--value'])).stdout.trim(); } catch {}
      if (linger !== 'yes') console.error('Boot startup is not verified: enable login lingering for this user with loginctl enable-linger before relying on unattended startup.');
    }
    console.log(quitting ? 'Slot preparation interrupted.'  : 'Ephemeral slot preparation complete.');
    configureAfter = !quitting && !noEnable;
  } else if (enable || disable) {
    configureAfter = true;
  } else {
    const state = {};
    do {
      let localReport;
      try {
        await boundControllerLog(root);
        // Invalid edits retain the last validated config so CPU control continues.
        try {
          const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
          if (raw.runners === undefined) throw new Error('Unpinned slots');
          c = validateConfig(raw);
        }
        catch { console.error('Config reload rejected; retaining previous configuration'); }
        const local = await localRunners(c);
        for (const name of state.failedStarts || []) {
          const slot = local.get(name);
          if (slot) { slot.unavailable = true; slot.active = true; slot.phase = 'blocked'; }
        }
        let unavailable = [...local.values()].filter(r => r.unavailable).length;
        if (unavailable) console.error(`${unavailable} slot(s) unavailable; healthy slots remain managed`);
        const host = hostSample();
        const active = [...local.values()].filter(r => r.active).length;
        const policy = cpuPolicy(c, active, host, state);
        if (apply && !quitting) {
          for (const r of [...local.values()].filter(r => !r.unavailable)) {
            if (quitting) break;
            if (r.quota !== policy.quota) {
              try { await setQuota(r, policy.quota); }
              catch { r.unavailable = true; r.phase = 'blocked'; continue; }
              r.quota = policy.quota;
            }
          }
        }
        await flushUnits();
        localReport = { mode: apply ? 'apply' : 'dry-run', queueAvailable: false, active, unavailable,
          pressure: policy.pressure, cpuQuotaPercent: policy.quota };
        // Local CPU control is complete before any authentication or GitHub calls.
        const api = githubClient(await token());
        const data = await snapshot(c, api, local);
        const remoteUnavailable = data.runners.filter(r => r.unavailable).length;
        if (remoteUnavailable) console.error(`${remoteUnavailable} remote slot identity check(s) failed; affected slots will not receive registrations`);
        const p = plan(c, data, local, host, state, Date.now());
        let started = 0;

        if (apply && !quitting) {
          // Set quotas before bringing more workers online, including stopped pool members.
          for (const r of [...local.values()].filter(r => !r.unavailable)) {
            if (quitting) break;
            if (r.quota !== p.quota) {
              try { await setQuota(r, p.quota); }
              catch { r.unavailable = true; r.phase = 'blocked'; }
            }
          }
          await flushUnits();
          for (const name of p.start) {
            if (quitting) break;
            const slot = local.get(name);
            if (slot.unavailable) continue;
            try {
            // Start only the parked supervisor, never a reused listener identity.
            if (!slot.running) await command('./svc.sh', ['start'], slot.directory);
            await publishGeneration(c, name, slot, api);
            started++;
            if (p.desired > (state.grantedTarget || c.minRunners)) state.lastScale = Date.now();
            state.grantedTarget = Math.max(state.grantedTarget || c.minRunners, p.active + started);
            } catch (error) {
              if (error.registrationFailure) throw error;
              state.failedStarts ??= new Set();
              state.failedStarts.add(name);
              unavailable++;
              console.error('Local slot start/handoff failed; slot quarantined until controller restart, other slots continue.');
            }
          }
        }

        console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', queued: p.queued, active: p.active, unavailable,
          busy: p.busy, desired: p.desired, pressure: p.pressure, cpuQuotaPercent: p.quota,
          loadPerCpu: Math.round(host.load * 100) / 100, plannedStarts: p.start.length,
          retiring: p.retiring, started }));
      } catch (error) {
        if (localReport) console.log(JSON.stringify(localReport));
        // No raw exception details: OS errors may contain paths, remote errors may contain private payloads.
        console.error(error instanceof AutoscaleError ? error.message : 'Autoscale poll failed; inspect local slot files and services.');
        if (!watch) { process.exitCode = 1; break; }
      }
      if (watch && !quitting) {
        sleeper = new AbortController();
        await sleep(c.intervalSeconds * 1000, undefined, { signal: sleeper.signal }).catch(() => {});
      }
    } while (watch && !quitting);
  }
} catch (error) {
  // Only expose our static diagnostics, never file contents, JSON parse errors, or subprocess stderr.
  console.error(error instanceof AutoscaleError ? error.message : 'Autoscaler setup failed; check the config file and local filesystem permissions.');
  process.exitCode = 1;
} finally {
  if (releaseLock) await releaseLock();
  if (configureAfter) {
    try {
      await configureController({ root, configPath }, command, !disable);
      console.log(disable ? 'Background autoscaling disabled; current jobs continue.' : 'Background autoscaling enabled and started.');
    } catch {
      console.error('Controller service setup failed; inspect the user service manager.');
      process.exitCode = 1;
    }
  }
}
