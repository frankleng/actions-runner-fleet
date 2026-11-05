#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseRegistry, parseServiceStatusOutput } from '../lib/runnerctl-core.mjs';
import { AutoscaleError, validateConfig, githubClient, snapshot, hostSample, plan, cpuPolicy, effectiveQuota, reservationDecision, runnerListEndpoint, nextGithubPollAt, localSharing,
  githubFailure, trackHealth, healthWriteDue, HEALTH_FILE } from '../lib/runnerctl-autoscale.mjs';

import { acquireControllerLock, configureController, boundControllerLog } from '../lib/runnerctl-autoscale-service.mjs';
import { filePrivate, restrictToOwner, scriptCommand, WINDOWS_SERVICE_ENV_KEYS } from '../lib/runnerctl-platform.mjs';
import { checkDue, checkForUpdate, readUpdateState, writeUpdateState, readyTarget, rollSlot, diagnoseBlockedSlot, orphanDecision, pruneImages,
  bootstrapVersion, runnerPlatform, rollSupported, compareVersions, runnerFilesVersion, clearRecoveredGeneration, finishRecovery,
  SLOT_UPDATE_JOURNAL, SLOT_RECOVERY_JOURNAL } from '../lib/runnerctl-runner-update.mjs';
import { acquireLock } from '../../overlay/autoscale-lock.mjs';

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
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS',
  ...(process.platform === 'win32' ? WINDOWS_SERVICE_ENV_KEYS : [])].filter(k => process.env[k]).map(k => [k, process.env[k]]));
async function command(scriptFile, scriptArgs, cwd = root, timeout = 60000) {
  const { file, args: commandArgs } = scriptCommand(scriptFile, scriptArgs);
  if (timeout === 0) {
    // Provisioners can emit unbounded output; avoid execFile's buffer kill.
    return await new Promise((resolve, reject) => {
      const child = spawn(file, commandArgs, { cwd, env: serviceEnv, stdio: 'ignore', windowsHide: true });
      child.once('error', () => reject(new AutoscaleError('Local provisioning failed')));
      child.once('close', code => code === 0 ? resolve({ stdout: '' }) : reject(new AutoscaleError('Local provisioning failed; rerun --prepare to resume')));
    });
  }
  try { return await exec(file, commandArgs, { cwd, env: serviceEnv, timeout, maxBuffer: 1024 * 1024, windowsHide: true }); }
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
    // Linux reports the cgroup cap and Windows the job object cap; macOS has no live cap to read.
    if (['linux', 'win32'].includes(process.platform) && status === 'running') quota = effectiveQuota(stdout, quota);
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
    const runnerVersion = await runnerFilesVersion(directory);
    if (await fs.access(path.join(directory, SLOT_RECOVERY_JOURNAL)).then(() => true, () => false)) {
      // A proven recovery was interrupted; the next maintenance step finishes it.
      result.set(name, { directory, running: status === 'running', quota, active: true, phase, unavailable: true, runnerVersion, recoveryPending: true });
      continue;
    }
    if (phase === 'blocked') {
      // Only a listener GitHub refused for a deprecated runner, proven from the
      // slot's own diagnostics, is a candidate for automatic recovery.
      const diagnosis = await diagnoseBlockedSlot(directory);
      if (diagnosis.cause !== 'deprecated-runner') throw new AutoscaleError('Slot blocked; inspect its local lifecycle files');
      result.set(name, { directory, running: status === 'running', quota, active: true, phase, unavailable: true, runnerVersion, deprecated: diagnosis });
      continue;
    }
    if (await fs.access(path.join(directory, SLOT_UPDATE_JOURNAL)).then(() => true, () => false)) {
      // A runner roll was interrupted; only finishing it returns the slot to service.
      if (inflight || request || runner || phase !== 'ready') throw new AutoscaleError('Slot blocked; inspect its local lifecycle files');
      result.set(name, { directory, running: status === 'running', quota, id: generation?.id, active: true, phase, unavailable: true, runnerVersion, updatePending: true });
      continue;
    }
    const reservationPath = path.join(directory, '.autoscale-reservation.json');
    if (await readJson(reservationPath)) {
      // Only a reservation with nothing handed to the slot can be resolved automatically.
      const credentials = await fs.access(path.join(directory, '.credentials')).then(() => true, () => false) ||
        await fs.access(path.join(directory, '.credentials_rsaparams')).then(() => true, () => false);
      if (inflight || request || runner || credentials || phase !== 'ready') throw new AutoscaleError('Slot blocked; inspect its local lifecycle files');
      const { mtimeMs } = await fs.stat(reservationPath);
      result.set(name, { directory, running: status === 'running', quota, id: generation?.id, active: false, phase, runnerVersion,
        unavailable: true, reservation: { path: reservationPath, createdAt: mtimeMs } });
      continue;
    }
    const active = !!inflight || !!request || !!runner || phase === 'running';
    if (active && status === 'stopped') throw new AutoscaleError('Active generation has no running service; manual recovery required');
    if (runner && runner.ephemeral !== true) throw new AutoscaleError('Persistent registration in an ephemeral slot');
    const id = runner?.agentId ?? (inflight || request ? JSON.parse((inflight || request)['.runner']).agentId : generation?.id);
    result.set(name, { directory, running: status === 'running', quota, id, active, phase, runnerVersion });
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
async function resolveReservations(c, api, local) {
  const reserved = [...local.values()].filter(slot => slot.reservation);
  if (!reserved.length) return;
  const remote = await api(runnerListEndpoint(c), 'runners');
  let resolved = 0;
  for (const [name, slot] of local) {
    if (!slot.reservation || quitting) continue;
    const decision = reservationDecision(name, remote, Date.now() - slot.reservation.createdAt);
    if (decision.action === 'wait' || decision.action === 'keep') continue;
    try {
      if (decision.action === 'delete') await api.remove(c, decision.id);
      await fs.unlink(slot.reservation.path);
    } catch { continue; }
    slot.unavailable = false;
    delete slot.reservation;
    resolved++;
  }
  const pending = reserved.length - resolved;
  if (resolved) console.error(`${resolved} ambiguous registration(s) resolved; slot(s) returned to service`);
  if (pending) console.error(`${pending} ambiguous registration(s) awaiting resolution`);
}
// Runner updates. Windows slots stay on the pinned version (see README).
const updatePlatform = rollSupported() ? runnerPlatform() : null;
const overlayDir = path.join(root, 'overlay');
const ROLLS_PER_POLL = 4;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let updateState = { version: 1 };
let updateTask = null;
let lastPruneAt = 0;
const updateAbort = new AbortController();
// Writes are serialized; each writes the newest state.
let updateSaved = Promise.resolve();
function saveUpdateState(next) {
  updateState = next;
  updateSaved = updateSaved.then(() => writeUpdateState(root, updateState)).catch(() => console.error('Could not write runner update state'));
  return updateSaved;
}
// Release checks run beside polls, so a download never holds up CPU control.
function startUpdateCheck(c, tokenValue, signals) {
  if (!updatePlatform || updateTask || quitting) return;
  const due = checkDue(updateState, c, Date.now(), signals);
  if (!due) return;
  const before = updateState.target?.version ?? null;
  updateTask = checkForUpdate(updateState, c, { root, token: tokenValue, forced: due === 'forced', p: updatePlatform, signal: updateAbort.signal })
    .then(async next => {
      // Deprecation evidence may have arrived meanwhile.
      await saveUpdateState({ ...next, deprecated: updateState.deprecated ?? null });
      if (next.target && next.target.version !== before) console.error(`Runner ${next.target.version} verified; slots take it between generations`);
      if (next.refusal) console.error('Runner update refused; keeping the current runner version (see runnerctl health)');
      else if (next.error) console.error('Runner update check failed; retrying later');
    })
    .catch(() => console.error('Runner update check failed; retrying later'))
    .finally(() => { updateTask = null; });
}
const versionDeprecated = version => !!(version && updateState.deprecated && compareVersions(version, updateState.deprecated.version) <= 0);
const outdated = (slot, target) => !!(target && slot.runnerVersion && compareVersions(slot.runnerVersion, target.version) < 0);
async function rollToTarget(slot, target) {
  try { slot.runnerVersion = await rollSlot(slot.directory, { image: target?.image, version: target?.version, overlayDir }); }
  catch (error) {
    // Past the journal the slot is neither version; keep it out of service.
    if (await fs.access(path.join(slot.directory, SLOT_UPDATE_JOURNAL)).then(() => true, () => false)) Object.assign(slot, { unavailable: true, updatePending: true });
    throw error;
  }
}
// A deprecation-blocked slot ran no job, and its one-use credentials are dead.
// It never replays them: its orphan registration is removed, its parked
// supervisor stopped, and the consumed generation cleared so the slot can take
// a fresh JIT registration once its runner files are current.
async function recoverDeprecated(c, api, name, slot, remote) {
  const decision = orphanDecision(name, slot.deprecated.agentId, remote);
  if (decision.action === 'keep') return false;
  if (decision.action === 'delete') await api.remove(c, decision.id);
  await withStoppedWorker(slot, async () => {
    const again = await diagnoseBlockedSlot(slot.directory);
    if (again.cause !== 'deprecated-runner' || again.agentId !== slot.deprecated.agentId) throw new AutoscaleError('Slot evidence changed');
    await clearRecoveredGeneration(slot.directory, again.agentId);
  });
  Object.assign(slot, { active: false, phase: 'ready', unavailable: false, running: false, id: undefined, deprecated: undefined });
  return true;
}
// Stop the slot's supervisor and hold its lock: the worker holds it while it
// lives, so taking it proves no worker (and so no listener) runs.
async function withStoppedWorker(slot, fn) {
  await command('./svc.sh', ['stop'], slot.directory);
  let release;
  try { release = await acquireLock(slot.directory, '.autoscale-worker.lock'); }
  catch { throw new AutoscaleError('Slot supervisor still running'); }
  try { return await fn(); } finally { await release(); }
}
// Generation-boundary work before the poll's registrations: finish interrupted
// rolls, recover deprecation-blocked slots, and update idle outdated slots.
async function maintainRunnerFiles(c, api, local, target) {
  let budget = ROLLS_PER_POLL;
  let interrupted = 0;
  for (const slot of local.values()) {
    if (!slot.recoveryPending || quitting) continue;
    try {
      await withStoppedWorker(slot, () => finishRecovery(slot.directory));
      Object.assign(slot, { active: false, phase: 'ready', unavailable: false, running: false, id: undefined, recoveryPending: false });
      console.error('Finished an interrupted deprecated-runner recovery without replaying credentials');
    } catch { console.error('An interrupted deprecated-runner recovery could not be finished; inspect .autoscale-recovery.json'); }
  }
  for (const slot of local.values()) {
    if (!slot.updatePending || quitting) continue;
    try { await rollToTarget(slot, target); Object.assign(slot, { unavailable: false, active: false, updatePending: false }); budget--; }
    catch { interrupted++; }
  }
  if (interrupted) console.error(`${interrupted} slot(s) hold an interrupted runner update; inspect .autoscale-update.json and the slot's bin/`);
  if (c.runnerUpdates !== 'off' && target) {
    const deprecated = [...local.entries()].filter(([, s]) => s.deprecated && compareVersions(target.version, s.deprecated.version) > 0);
    if (deprecated.length) {
      const remote = await api(runnerListEndpoint(c), 'runners');
      let recovered = 0;
      for (const [name, slot] of deprecated) {
        if (quitting || budget <= 0) break;
        try { if (await recoverDeprecated(c, api, name, slot, remote)) recovered++; }
        catch { continue; }
        budget--;
        try { await rollToTarget(slot, target); } catch { console.error('Runner update failed for a recovered slot; it updates before its next registration'); }
      }
      if (recovered) console.error(`${recovered} slot(s) recovered from a deprecated runner version without replaying credentials`);
    }
  }
  if (c.runnerUpdates === 'off' || !target) return;
  for (const slot of local.values()) {
    if (quitting || budget <= 0) break;
    if (slot.unavailable || slot.active || slot.phase !== 'ready' || slot.reservation || !outdated(slot, target)) continue;
    budget--;
    try { await rollToTarget(slot, target); }
    catch { console.error('Runner update failed for an idle slot; it retries before its next registration'); }
  }
  // Pruning never overlaps an update check, which is what publishes targets,
  // and keeps the target as published now, not as this poll first saw it.
  if (!updateTask && Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
    lastPruneAt = Date.now();
    try {
      const published = updateState.target?.version;
      const registry = parseRegistry(await fs.readFile(path.join(root, 'runners.tsv'), 'utf8'));
      const removed = await pruneImages(root, updatePlatform, registry.map(r => path.resolve(r.directory)),
        [target.version, published, await bootstrapVersion(root)], { floor: published });
      if (removed.length) console.error(`Removed ${removed.length} unused runner image(s)`);
    } catch { console.error('Unused runner images could not be pruned'); }
  }
}
let cachedToken;
// Which source the last token came from (env, file, gh); never the value.
let tokenSource = null;
const noToken = message => Object.assign(new AutoscaleError(message), { githubKind: 'no-token' });
async function token() {
  tokenSource = null;
  if (process.env.RUNNER_AUTOSCALE_TOKEN) { tokenSource = 'env'; return process.env.RUNNER_AUTOSCALE_TOKEN; }
  const tokenFile = process.env.RUNNER_AUTOSCALE_TOKEN_FILE || path.join(root, '.autoscale-token');
  const stat = await fs.stat(tokenFile).catch(() => null);
  if (stat) {
    if (!await filePrivate(tokenFile, stat)) {
      throw Object.assign(new AutoscaleError(process.platform === 'win32' ? 'Token file must be a regular file readable only by this user'
        : 'Token file must be a regular file owned by this user with mode 0600'), { githubKind: 'token-file' });
    }
    const value = (await fs.readFile(tokenFile, 'utf8')).trim();
    if (value) { tokenSource = 'file'; return value; }
  }
  try {
    const { stdout } = await exec('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 15000, maxBuffer: 65536 });
    if (stdout.trim()) { tokenSource = 'gh'; return (cachedToken = stdout.trim()); }
  } catch {}
  // gh reads a desktop keyring that locks when its daemon restarts; keep polling with the last good token.
  if (cachedToken) { tokenSource = 'gh'; return cachedToken; }
  throw noToken('Set RUNNER_AUTOSCALE_TOKEN, RUNNER_AUTOSCALE_TOKEN_FILE, or authenticate gh for github.com');
}
// Only the background controller (continuous apply) reports health; previews
// and one-off polls must not refresh the heartbeat of a hung controller.
const healthPath = path.join(root, HEALTH_FILE);
let health = null;
let healthWritten = null;
async function recordHealth(poll) {
  health = trackHealth(health, poll, c);
  if (!healthWriteDue(healthWritten, health, poll.at)) return;
  try {
    // Restrict the empty file first, then fill it; rename keeps its access list.
    await fs.rm(`${healthPath}.tmp`, { force: true });
    await fs.writeFile(`${healthPath}.tmp`, '', { mode: 0o600, flag: 'wx' });
    await restrictToOwner(`${healthPath}.tmp`);
    await fs.writeFile(`${healthPath}.tmp`, JSON.stringify(health));
    await fs.rename(`${healthPath}.tmp`, healthPath);
    healthWritten = { state: health, at: poll.at };
  } catch { console.error('Could not write autoscaler health state'); }
}
process.on('SIGTERM', () => { quitting = true; sleeper?.abort(); updateAbort.abort(); });
process.on('SIGINT', () => { quitting = true; sleeper?.abort(); updateAbort.abort(); });
let c;
try {
  const initialRaw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  c = validateConfig(initialRaw);
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
    const etags = new Map();
    let githubNotBefore = 0;
    const reportHealth = apply && watch;
    // A restart keeps the failure clocks running, so a crash loop still alerts.
    if (reportHealth) health = await readJson(healthPath).catch(() => null);
    if (apply) {
      updateState = await readUpdateState(root);
      // Leftovers of an interrupted download or extraction; this controller holds the kit lock.
      for (const leaf of await fs.readdir(root)) {
        if (/^\.autoscale-runner-(download|image)\./.test(leaf)) await fs.rm(path.join(root, leaf), { recursive: true, force: true });
      }
    }
    do {
      let localReport;
      let api;
      const poll = { at: Date.now(), outcome: 'local' };
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
        // GitHub refused a listener for its runner version: remember the
        // version so no further registration is spent on it.
        const refused = [...local.values()].filter(s => s.deprecated).map(s => s.deprecated.version)
          .sort(compareVersions).at(-1);
        if (apply && refused && !versionDeprecated(refused)) await saveUpdateState({ ...updateState, deprecated: { version: refused, seenAt: Date.now() } });
        for (const name of state.failedStarts || []) {
          const slot = local.get(name);
          if (slot) { slot.unavailable = true; slot.active = true; slot.phase = 'blocked'; }
        }
        let unavailable = [...local.values()].filter(r => r.unavailable).length;
        if (unavailable) console.error(`${unavailable} slot(s) unavailable; healthy slots remain managed`);
        const host = hostSample();
        const active = [...local.values()].filter(r => r.active).length;
        const policy = cpuPolicy(c, localSharing(c, state, active, Date.now()), host, state);
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
        if (Date.now() < githubNotBefore) throw Object.assign(new AutoscaleError('GitHub reads paused near the token rate limit; local CPU control continues'), { githubKind: 'rate-limit' });
        let tokenValue;
        try { tokenValue = await token(); api = githubClient(tokenValue, fetch, etags); }
        finally { poll.tokenSource = tokenSource; }
        let target = null;
        if (apply && !quitting) {
          target = updatePlatform && c.runnerUpdates !== 'off' ? await readyTarget(updateState, root) : null;
          startUpdateCheck(c, tokenValue, { deprecationSeen: !!refused, targetMissing: !!updateState.target && !target });
          await resolveReservations(c, api, local);
          await maintainRunnerFiles(c, api, local, target);
          unavailable = [...local.values()].filter(r => r.unavailable).length;
        }
        const data = await snapshot(c, api, local);
        Object.assign(poll, { githubOk: true, observed: { queued: data.queued, online: data.online, busy: data.runners.filter(r => r.busy).length } });
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
            // Runner files change only here, between generations, before the next registration.
            if (outdated(slot, target)) {
              try { await rollToTarget(slot, target); }
              catch { console.error('Runner update failed before a registration; slot skipped this poll'); continue; }
            }
            // A version GitHub refuses would only burn a one-use registration.
            if (versionDeprecated(slot.runnerVersion)) continue;
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

        poll.outcome = 'ok';
        console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', queued: p.queued, waiting: p.waiting, active: p.active, unavailable,
          busy: p.busy, desired: p.desired, pressure: p.pressure, cpuQuotaPercent: p.quota,
          loadPerCpu: Math.round(host.load * 100) / 100, plannedStarts: p.start.length,
          retiring: p.retiring, started, ...(Number.isFinite(api.rate.remaining) ? { rateRemaining: api.rate.remaining } : {}),
          ...(target ? { runnerTarget: target.version, outdated: [...local.values()].filter(s => outdated(s, target)).length } : {}) }));
      } catch (error) {
        const failure = githubFailure(error);
        if (failure) Object.assign(poll, { outcome: 'failed', failure });
        if (localReport) console.log(JSON.stringify(localReport));
        // No raw exception details: OS errors may contain paths, remote errors may contain private payloads.
        console.error(error instanceof AutoscaleError ? error.message : 'Autoscale poll failed; inspect local slot files and services.');
        if (!watch) { process.exitCode = 1; break; }
      }
      // A failed poll still reports what GitHub said about the token's budget.
      if (api) githubNotBefore = nextGithubPollAt(api.rate, Date.now());
      if (reportHealth) await recordHealth(poll);
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
  // A signal already aborted any download; a one-off poll lets its check finish.
  await updateTask;
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
