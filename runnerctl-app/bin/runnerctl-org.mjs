#!/usr/bin/env node
// runnerctl org: create, start, stop, upgrade, and inspect one long-lived
// container per GitHub organization (docs/org-containers.md). Docker runs
// through execFile with argument arrays only; no shell ever sees a value.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { OrgConfigError, validateOrgConfig, selectOrg, imageTag, dockerBuildArgs, networkCreateArgs, containerCreateArgs,
  execArgs, configHash, setupScript, IMAGE_FILES, LABEL } from '../lib/runnerctl-org-container.mjs';
import { renderRunnerStatsMarkdown } from '../lib/runnerctl-stats.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contextDir = path.join(root, 'container');
const dockerBin = process.env.RUNNER_DOCKER_BIN || 'docker';
const usage = `Usage: runnerctl org COMMAND [ORG] [options]

Preview (no changes):
  config [ORG]           Print the validated configuration
  render ORG             Print the build, network, and create commands
  setup-script ORG       Print the one-time root setup script for ORG's data directories
  check-host             Check Docker, the Sysbox runtime, cgroup v2, networks, and containers

Lifecycle (each refuses unsafe states; --dry-run prints instead of running):
  build ORG              Build ORG's image (tag derived from container/ and its build arguments)
  network ORG            Create ORG's bridge network once; verify it if it exists
  create ORG             Create ORG's container (requires image, network, and data directories)
  start ORG | stop ORG   Start, or stop when no job runs (--force stops anyway)
  drain ORG              Disable ORG's autoscaler and wait until no job runs
  upgrade ORG            Build if needed, drain, recreate on the new image, start, re-enable

Inspect:
  status [ORG] [--json]  Container, health, limits, autoscaler, listeners, and jobs per org
  stats [ORG] [--json]   Every org's runner stats table (runnerctl stats inside each container)
  exec ORG -- CMD...     Run CMD as the runner in ORG's kit directory

Options: --config FILE (default org-containers.json), --dry-run, --force, --timeout-minutes N.`;

const argv = process.argv.slice(2);
const options = { config: path.join(root, 'org-containers.json'), dryRun: false, force: false, json: false, timeoutMinutes: 180 };
const positional = [];
let passthrough = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { passthrough = argv.slice(i + 1); break; }
  if (a === '--help' || a === 'help') { console.log(usage); process.exit(0); }
  else if (a === '--config' && argv[i + 1]) options.config = path.resolve(argv[++i]);
  else if (a === '--dry-run') options.dryRun = true;
  else if (a === '--force') options.force = true;
  else if (a === '--json') options.json = true;
  else if (a === '--timeout-minutes' && /^\d+$/.test(argv[i + 1] ?? '')) options.timeoutMinutes = Number(argv[++i]);
  else if (a.startsWith('-')) { console.error(`runnerctl org: unknown option ${a}; use --help`); process.exit(2); }
  else positional.push(a);
}
const [commandName, orgName] = positional;

class Refusal extends Error {}
const refuse = message => { throw new Refusal(message); };

const quote = s => /^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
const show = args => [path.basename(dockerBin), ...args].map(quote).join(' ');

async function docker(args, { inherit = false, allowFailure = false } = {}) {
  if (inherit) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(dockerBin, args, { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (c, signal) => resolve(signal ? 1 : c));
    });
    if (code !== 0 && !allowFailure) refuse(`docker ${args[0]} failed (exit ${code})`);
    return { code };
  }
  try {
    const { stdout } = await exec(dockerBin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
    return { code: 0, stdout };
  } catch (error) {
    if (allowFailure) return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    refuse(`docker ${args[0]} ${args[1] ?? ''} failed: ${String(error.stderr || error.message).trim().split('\n').at(-1)}`);
  }
}

async function inspect(kind, name) {
  const result = await docker([kind, 'inspect', name], { allowFailure: true });
  if (result.code !== 0) return null;
  try { return JSON.parse(result.stdout)[0] ?? null; } catch { return null; }
}

async function loadConfig() {
  let stat;
  try { stat = await fs.lstat(options.config); }
  catch { refuse(`${options.config} not found; copy org-containers.example.json and edit it`); }
  // It decides what docker runs as root, so only its owner may write it.
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o022)) refuse(`${options.config} must be a regular file you own that only you can write`);
  let raw;
  try { raw = JSON.parse(await fs.readFile(options.config, 'utf8')); } catch { refuse(`${options.config} is not valid JSON`); }
  return validateOrgConfig(raw, { hostname: os.hostname() });
}

async function imageFiles() {
  const files = {};
  for (const name of IMAGE_FILES) files[name] = await fs.readFile(path.join(contextDir, name)).catch(() => undefined);
  return files;
}

async function expectedImage(o) { return imageTag(o, await imageFiles()); }

async function dockerInfo() {
  const { stdout } = await docker(['info', '--format', '{{json .}}']);
  return JSON.parse(stdout);
}

async function innerStatus(o) {
  const result = await docker(['exec', o.container, '/usr/local/bin/runner-org-status'], { allowFailure: true });
  if (result.code !== 0) return null;
  try { return JSON.parse(result.stdout.trim().split('\n').at(-1)); } catch { return null; }
}

async function checkNetwork(o) {
  const net = await inspect('network', o.network.name);
  if (!net) return null;
  const subnet = net.IPAM?.Config?.[0]?.Subnet;
  const bridge = net.Options?.['com.docker.network.bridge.name'];
  if (net.Driver !== 'bridge' || subnet !== o.network.subnet || bridge !== o.network.bridge) {
    refuse(`network ${o.network.name} exists with other settings (driver ${net.Driver}, subnet ${subnet}, bridge ${bridge}); it is never changed in place`);
  }
  return net;
}

async function requireRuntime(o) {
  if (o.runtime !== 'sysbox-runc') {
    console.error(`warning: ${o.org} uses the privileged fallback; root in its container is root on this host (docs/org-containers.md)`);
    return;
  }
  const info = await dockerInfo();
  if (!Object.keys(info.Runtimes ?? {}).includes('sysbox-runc')) {
    refuse('Docker has no sysbox-runc runtime; install Sysbox first (docs/org-containers.md, Host prerequisites)');
  }
}

async function cmdBuild(o) {
  const tag = await expectedImage(o);
  const args = dockerBuildArgs(o, contextDir, tag);
  if (options.dryRun) { console.log(show(args)); return tag; }
  if (await inspect('image', tag) && !options.force) { console.log(`${tag} is already built`); return tag; }
  await docker(args, { inherit: true });
  return tag;
}

async function cmdNetwork(o) {
  const args = networkCreateArgs(o);
  if (await checkNetwork(o)) { console.log(`network ${o.network.name} exists with bridge ${o.network.bridge} and subnet ${o.network.subnet}`); return; }
  if (options.dryRun) { console.log(show(args)); return; }
  await docker(args);
  console.log(`created network ${o.network.name} (bridge ${o.network.bridge}, ${o.network.subnet}); it stays until removed by hand`);
}

async function cmdCreate(o) {
  const image = await expectedImage(o);
  const args = containerCreateArgs(o, image);
  if (options.dryRun) { console.log(show(args)); return; }
  if (await inspect('container', o.container)) refuse(`${o.container} already exists; use upgrade to recreate it`);
  if (!await inspect('image', image)) refuse(`image ${image} is not built; run: runnerctl org build ${o.org}`);
  if (!await checkNetwork(o)) refuse(`network ${o.network.name} does not exist; run: runnerctl org network ${o.org}`);
  if (o.cpus > os.availableParallelism()) refuse(`${o.org}: cpus ${o.cpus} exceeds this host's ${os.availableParallelism()} CPUs`);
  const dir = await fs.stat(o.paths.root).catch(() => null);
  if (!dir?.isDirectory() || dir.uid !== o.uid) refuse(`${o.paths.root} must exist and belong to uid ${o.uid}; run the output of: runnerctl org setup-script ${o.org}`);
  await requireRuntime(o);
  await docker(args);
  console.log(`created ${o.container} on ${image}`);
}

async function waitHealthy(o, minutes = 5) {
  const until = Date.now() + minutes * 60000;
  while (Date.now() < until) {
    const c = await inspect('container', o.container);
    const health = c?.State?.Health?.Status;
    if (health === 'healthy') return true;
    if (!c?.State?.Running) refuse(`${o.container} stopped while starting; see: docker logs ${o.container}`);
    await sleep(5000);
  }
  return false;
}

async function cmdStart(o) {
  if (options.dryRun) { console.log(show(['start', o.container])); return; }
  const c = await inspect('container', o.container);
  if (!c) refuse(`${o.container} does not exist; run: runnerctl org create ${o.org}`);
  if (!c.State?.Running) await docker(['start', o.container]);
  console.log(await waitHealthy(o) ? `${o.container} is healthy` : `${o.container} started but is not healthy yet; check runnerctl org status ${o.org}`);
}

async function busyJobs(o) {
  const status = await innerStatus(o);
  if (!status) refuse(`cannot read ${o.container}'s status, so running jobs cannot be ruled out; use --force to stop anyway`);
  return status.jobs;
}

async function cmdStop(o) {
  const c = await inspect('container', o.container);
  if (!c?.State?.Running) { console.log(`${o.container} is not running`); return; }
  if (!options.force) {
    const jobs = await busyJobs(o);
    if (jobs > 0) refuse(`${o.container} is running ${jobs} job(s); drain it first (runnerctl org drain ${o.org}) or use --force`);
  }
  const args = ['stop', '--time', String(o.stopTimeoutSeconds), o.container];
  if (options.dryRun) { console.log(show(args)); return; }
  await docker(args);
  console.log(`stopped ${o.container}; it stays stopped across reboots until started`);
}

async function cmdDrain(o) {
  const c = await inspect('container', o.container);
  if (!c?.State?.Running) { console.log(`${o.container} is not running`); return { wasEnabled: false }; }
  const before = await innerStatus(o);
  const wasEnabled = before?.controller === 'active';
  const disable = execArgs(o, ['./runnerctl', 'autoscale', '--disable']);
  if (options.dryRun) { console.log(show(disable)); return { wasEnabled }; }
  if (before?.controller !== 'missing') await docker(disable);
  // A warm listener can still take a job after the controller stops, so idle
  // must hold for two checks in a row.
  const until = Date.now() + options.timeoutMinutes * 60000;
  let quiet = 0;
  while (quiet < 2) {
    if (Date.now() > until) refuse(`${o.container} still runs jobs after ${options.timeoutMinutes} minutes; its autoscaler stays disabled`);
    quiet = await busyJobs(o) === 0 ? quiet + 1 : 0;
    if (quiet < 2) await sleep(15000);
  }
  console.log(`${o.container} is drained: autoscaler disabled, no job running`);
  return { wasEnabled };
}

async function cmdUpgrade(o) {
  const image = await expectedImage(o);
  const current = await inspect('container', o.container);
  if (current && current.Config?.Image === image && current.Config?.Labels?.[`${LABEL}.config`] === configHash(o, image) && !options.force) {
    console.log(`${o.container} already runs ${image} with the current settings`);
    return;
  }
  if (options.dryRun) {
    console.log([`# upgrade ${o.org} to ${image}`, show(dockerBuildArgs(o, contextDir, image)),
      show(execArgs(o, ['./runnerctl', 'autoscale', '--disable'])), '# wait until no job runs',
      show(['stop', '--time', String(o.stopTimeoutSeconds), o.container]), show(['rm', o.container]),
      show(containerCreateArgs(o, image)), show(['start', o.container]),
      show(execArgs(o, ['./runnerctl', 'autoscale', '--enable']))].join('\n'));
    return;
  }
  await cmdBuild(o);
  let wasEnabled = false;
  if (current) {
    if (current.State?.Running) {
      ({ wasEnabled } = options.force ? { wasEnabled: (await innerStatus(o))?.controller === 'active' } : await cmdDrain(o));
      await docker(['stop', '--time', String(o.stopTimeoutSeconds), o.container]);
    }
    await docker(['rm', o.container]);
  }
  await cmdCreate(o);
  await cmdStart(o);
  if (wasEnabled) {
    await docker(execArgs(o, ['./runnerctl', 'autoscale', '--enable']));
    console.log(`re-enabled ${o.org}'s autoscaler`);
  } else console.log(`${o.org}'s autoscaler was not enabled before the upgrade; enable it with: runnerctl org exec ${o.org} -- ./runnerctl autoscale --enable`);
}

async function orgStatus(o) {
  const image = await expectedImage(o);
  const c = await inspect('container', o.container);
  const row = { org: o.org, container: o.container, state: c?.State?.Status ?? 'absent', health: c?.State?.Health?.Status ?? '-',
    runtime: c?.HostConfig?.Runtime ?? '-', cpus: c ? (c.HostConfig?.NanoCpus ?? 0) / 1e9 : null, memoryBytes: c?.HostConfig?.Memory ?? null,
    image: c?.Config?.Image ?? '-', expectedImage: image,
    upToDate: !!c && c.Config?.Image === image && c.Config?.Labels?.[`${LABEL}.config`] === configHash(o, image), inside: null };
  if (c?.State?.Running) row.inside = await innerStatus(o);
  return row;
}

const gib = b => Number.isFinite(b) && b > 0 ? `${(b / 2 ** 30).toFixed(1)} GiB` : '—';
async function cmdStatus(config, orgs) {
  const rows = await Promise.all(orgs.map(orgStatus));
  if (options.json) { console.log(JSON.stringify({ generatedAt: new Date().toISOString(), orgs: rows }, null, 2)); return; }
  const headers = ['Org', 'State', 'Health', 'Runtime', 'CPUs', 'Memory', 'Up to date', 'Docker', 'Autoscaler', 'Listeners', 'Jobs'];
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const r of rows) {
    lines.push(`| ${[r.org, r.state, r.health, r.runtime, r.cpus ?? '—', gib(r.memoryBytes), r.state === 'absent' ? '—' : (r.upToDate ? 'yes' : 'no'),
      r.inside?.docker ?? '—', r.inside?.controller ?? '—', r.inside?.listeners ?? '—', r.inside?.jobs ?? '—'].join(' | ')} |`);
  }
  console.log(lines.join('\n'));
}

async function cmdStats(orgs) {
  const sample = process.env.RUNNER_STATS_SAMPLE_MS;
  const reports = await Promise.all(orgs.map(async o => {
    const c = await inspect('container', o.container);
    if (!c?.State?.Running) return { org: o.org, runners: [] };
    const command = ['env', ...(sample !== undefined ? [`RUNNER_STATS_SAMPLE_MS=${sample}`] : []), './runnerctl', 'stats', '--json'];
    const result = await docker(execArgs(o, command), { allowFailure: true });
    try { return { org: o.org, ...JSON.parse(result.stdout) }; }
    catch { return { org: o.org, runners: [], error: 'stats unavailable' }; }
  }));
  const merged = { generatedAt: new Date().toISOString(), sampleWindowMs: Math.max(0, ...reports.map(r => r.sampleWindowMs ?? 0)),
    runners: reports.flatMap(r => (r.runners ?? []).map(runner => ({ ...runner, name: `${r.org}/${runner.name}` }))) };
  if (options.json) console.log(JSON.stringify(merged, null, 2));
  else console.log(renderRunnerStatsMarkdown(merged));
  for (const r of reports.filter(r => r.error)) console.error(`${r.org}: ${r.error}`);
}

async function cmdCheckHost(config) {
  const checks = [];
  const add = (ok, what, hint = '') => checks.push({ ok, what, hint });
  let info = null;
  try { info = await dockerInfo(); add(true, `Docker ${info.ServerVersion} reachable`); }
  catch { add(false, 'Docker reachable', 'is the docker CLI installed and may this user use it?'); }
  if (info) {
    add(String(info.CgroupVersion) === '2', `cgroup v${info.CgroupVersion}`, 'org containers need cgroup v2');
    const needSysbox = Object.values(config.orgs).some(o => o.runtime === 'sysbox-runc');
    if (needSysbox) add(Object.keys(info.Runtimes ?? {}).includes('sysbox-runc'), 'sysbox-runc runtime registered', 'install Sysbox (docs/org-containers.md)');
    const [major, minor] = String(info.KernelVersion).split('.').map(Number);
    add(major > 5 || (major === 5 && minor >= 12), `kernel ${info.KernelVersion}`, 'Sysbox needs 5.12+ for ID-mapped mounts');
  }
  const rootStat = await fs.stat(config.dataRoot).catch(() => null);
  add(!!rootStat && rootStat.uid === 0 && (rootStat.mode & 0o777) === 0o711, `${config.dataRoot} is root-owned 0711`, 'run the setup-script output with sudo');
  for (const o of Object.values(config.orgs)) {
    const dir = await fs.stat(o.paths.root).catch(() => null);
    add(!!dir && dir.uid === o.uid, `${o.org}: data directory owned by uid ${o.uid}`, `runnerctl org setup-script ${o.org}`);
    let net = null;
    try { net = info ? await checkNetwork(o) : null; } catch (error) { add(false, `${o.org}: network ${o.network.name}`, error.message); continue; }
    add(!!net, `${o.org}: network ${o.network.name}`, `runnerctl org network ${o.org}`);
    const c = info ? await inspect('container', o.container) : null;
    add(!!c, `${o.org}: container ${o.container}${c ? ` (${c.State?.Status})` : ''}`, `runnerctl org create ${o.org}`);
  }
  for (const c of checks) console.log(`${c.ok ? 'ok     ' : 'missing'} ${c.what}${c.ok || !c.hint ? '' : ` — ${c.hint}`}`);
  if (checks.some(c => !c.ok)) process.exitCode = 1;
}

async function cmdExec(o) {
  if (!passthrough?.length) refuse('usage: runnerctl org exec ORG -- COMMAND [ARGS...]');
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
  const { code } = await docker(execArgs(o, passthrough, { stdin: true, tty }), { inherit: true, allowFailure: true });
  process.exitCode = code;
}

async function sourceInfo() {
  let originUrl = null;
  try { originUrl = (await exec('git', ['-C', root, 'remote', 'get-url', 'origin'])).stdout.trim() || null; } catch {}
  // A local path origin would point the org kit back at this checkout.
  if (originUrl && !/^(https:\/\/|git@|ssh:\/\/)/.test(originUrl)) originUrl = null;
  return { source: root, originUrl };
}

try {
  if (!commandName) { console.log(usage); process.exit(0); }
  const config = await loadConfig();
  const one = () => {
    if (!orgName) refuse(`runnerctl org ${commandName} needs an organization`);
    return selectOrg(config, orgName);
  };
  const some = () => orgName ? [selectOrg(config, orgName)] : Object.values(config.orgs);
  switch (commandName) {
    case 'config': console.log(JSON.stringify(orgName ? one() : config, null, 2)); break;
    case 'render': {
      const o = one();
      const image = await expectedImage(o);
      console.log([`# ${o.org}: image ${image}`, '# 1. once, as root: the data directories',
        `runnerctl org setup-script ${o.org} > setup-${o.id}.sh && sudo bash setup-${o.id}.sh`,
        '# 2. the image', show(dockerBuildArgs(o, contextDir, image)),
        '# 3. once: the org bridge (one host interface, never changed per job)', show(networkCreateArgs(o)),
        '# 4. the container', show(containerCreateArgs(o, image)), show(['start', o.container])].join('\n'));
      break;
    }
    case 'setup-script': process.stdout.write(setupScript(config, one(), await sourceInfo())); break;
    case 'check-host': await cmdCheckHost(config); break;
    case 'build': await cmdBuild(one()); break;
    case 'network': await cmdNetwork(one()); break;
    case 'create': await cmdCreate(one()); break;
    case 'start': await cmdStart(one()); break;
    case 'stop': await cmdStop(one()); break;
    case 'drain': await cmdDrain(one()); break;
    case 'upgrade': await cmdUpgrade(one()); break;
    case 'status': await cmdStatus(config, some()); break;
    case 'stats': await cmdStats(some()); break;
    case 'exec': await cmdExec(one()); break;
    default: refuse(`unknown command ${commandName}; use --help`);
  }
} catch (error) {
  if (error instanceof Refusal || error instanceof OrgConfigError) console.error(`runnerctl org: ${error.message}`);
  else console.error(`runnerctl org failed: ${error.message}`);
  process.exitCode = 1;
}
