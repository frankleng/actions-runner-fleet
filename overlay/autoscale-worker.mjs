// A local slot accepts one credential handoff at a time. It never kills a listener
// to reduce capacity, and never reuses a consumed ephemeral registration.
import { acquireLock } from './autoscale-lock.mjs';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const lock = '.autoscale-worker.lock';
const request = '.autoscale-request.json';
const inflight = '.autoscale-inflight.json';
let stopping = false;
let child;
let owned = false;
let release;
const exists = async name => fs.access(name).then(() => true, () => false);
async function state(phase) {
  await fs.writeFile('.autoscale-state.tmp', JSON.stringify({ phase }), { mode: 0o600 });
  await fs.rename('.autoscale-state.tmp', '.autoscale-state.json');
}
// The Windows runner reads its RSA key through DPAPI, as written by config.cmd
// and --jitconfig. The key travels over stdin, never in arguments.
async function protectForWindows(text) {
  const script = 'Add-Type -AssemblyName System.Security; ' +
    '$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ' +
    '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine))';
  const powershell = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const protectedKey = await new Promise((resolve, reject) => {
    const helper = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    helper.stdout.on('data', chunk => { stdout += chunk; });
    helper.once('error', reject);
    helper.once('close', code => code === 0 && stdout.trim() ? resolve(stdout.trim()) : reject(new Error('Key protection failed')));
    helper.stdin.end(Buffer.from(text, 'utf8').toString('base64'));
  });
  return Buffer.from(protectedKey, 'base64');
}
// Jobs leave processes behind: dev servers and build daemons started with
// setsid or double forks, which reparent to the user manager. The runner's
// own cleanup kills only the tracked processes it saw in one snapshot, so a
// process forked after it survives, and nothing else removes it until the
// unit restarts. On Linux each generation's listener therefore runs in a child
// cgroup of this unit; once the listener exits, everything still in it is job
// leftovers. This process, the launcher, and other slots are never inside it.
const JOB_CGROUP = 'runner-job';
const JOB_CLEANUP_GRACE_MS = 5000;
async function jobCgroup() {
  if (process.platform !== 'linux') return null;
  try {
    const own = (await fs.readFile('/proc/self/cgroup', 'utf8')).split('\n').find(line => line.startsWith('0::'))?.slice(3);
    // Only a service's own cgroup: never a terminal's or a test runner's scope.
    if (!own?.startsWith('/') || !own.endsWith('.service')) return null;
    const dir = path.join('/sys/fs/cgroup', own, JOB_CGROUP);
    await fs.mkdir(dir).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await fs.access(path.join(dir, 'cgroup.procs'), fsConstants.W_OK);
    return dir;
  } catch (error) {
    console.error(`Job process cleanup unavailable: no writable cgroup v2 child (${error.code ?? error.message})`);
    return null;
  }
}
const cgroupPids = async dir => (await fs.readFile(path.join(dir, 'cgroup.procs'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number);
const cgroupEmpty = async dir => /^populated 0$/m.test(await fs.readFile(path.join(dir, 'cgroup.events'), 'utf8').catch(() => 'populated 0'));
async function waitEmpty(dir, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await cgroupEmpty(dir)) return true;
  return cgroupEmpty(dir);
}
// Logs only process names and counts: arguments and environments can hold secrets.
async function cleanJobCgroup(dir) {
  const pids = await cgroupPids(dir);
  if (!pids.length && await cgroupEmpty(dir)) { console.error('Job process cleanup: no leftover processes'); return; }
  const names = new Map();
  const own = path.relative('/sys/fs/cgroup', dir);
  for (const pid of pids) {
    const name = (await fs.readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '?')).trim() || '?';
    names.set(name, (names.get(name) ?? 0) + 1);
    // Signal only a process still in this cgroup, never a reused PID elsewhere.
    if ((await fs.readFile(`/proc/${pid}/cgroup`, 'utf8').catch(() => '')).includes(`0::/${own}\n`)) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
  }
  let killed = 0;
  if (!await waitEmpty(dir, JOB_CLEANUP_GRACE_MS)) {
    killed = (await cgroupPids(dir)).length;
    // cgroup.kill also takes processes forked during the grace period.
    await fs.writeFile(path.join(dir, 'cgroup.kill'), '1').catch(async () => {
      for (const pid of await cgroupPids(dir)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    });
  }
  const remaining = await waitEmpty(dir, 5000) ? 0 : (await cgroupPids(dir)).length;
  const summary = [...names].map(([name, count]) => `${name} x${count}`).join(', ');
  console.error(`Job process cleanup: stopped ${pids.length} leftover process(es): ${summary}` +
    `${killed ? `; ${killed} needed SIGKILL` : ''}${remaining ? `; ${remaining} could not be stopped` : ''}`);
}
// Even a controller/service shutdown waits for a currently accepted job. The OS
// may still enforce its own service-stop deadline; autoscale never requests one.
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
try {
  release = await acquireLock(process.cwd(), lock);
  owned = true;
  if (await exists(inflight)) throw new Error('Unfinished generation');
  // Existing credentials mean an interrupted generation, not permission to replay it.
  if (await exists('.runner') || await exists('.credentials') || await exists('.credentials_rsaparams')) throw new Error('Unfinished registration');
  const cgroup = await jobCgroup();
  await state('ready');
  while (!stopping) {
    // The controller replaces runner files only between generations; never
    // start a listener from a half-swapped bin/ or externals/.
    if (!await exists(request) || await exists('.autoscale-update.json')) { await sleep(1000); continue; }
    await fs.rename(request, inflight);
    await state('running');
    const files = JSON.parse(await fs.readFile(inflight, 'utf8'));
    const allowed = ['.runner', '.credentials', '.credentials_rsaparams'];
    if (Object.keys(files).length !== 3 || allowed.some(k => typeof files[k] !== 'string')) throw new Error('Invalid handoff');
    const metadata = JSON.parse(files['.runner']);
    const slot = JSON.parse(await fs.readFile('.autoscale-slot.json', 'utf8'));
    if (metadata.ephemeral !== true || metadata.agentName !== slot.agentName ||
        metadata.gitHubUrl?.replace(/\/+$/, '').toLowerCase() !== slot.gitHubUrl.replace(/\/+$/, '').toLowerCase()) throw new Error('Invalid identity');
    for (const name of allowed) {
      const content = process.platform === 'win32' && name === '.credentials_rsaparams' ? await protectForWindows(files[name]) : files[name];
      await fs.writeFile(name, content, { mode: 0o600, flag: 'wx' });
    }
    // The runner reads its private config files: no credentials in argv or environment.
    const code = await new Promise(resolve => {
      // On Windows the listener shares this hidden console, so a service stop's Ctrl+C reaches both.
      const listener = [process.platform === 'win32' ? '.\\bin\\Runner.Listener.exe' : './bin/Runner.Listener', 'run', '--startuptype', 'service'];
      // The shell joins the job cgroup before it becomes the listener, so every
      // descendant starts inside it. Containment never decides whether a job runs.
      child = cgroup
        ? spawn('/bin/sh', ['-c', '{ echo 0 > "$0/cgroup.procs"; } 2>/dev/null || echo "Job process cleanup: could not join $0" >&2; exec "$@"', cgroup, ...listener], { stdio: 'inherit' })
        : spawn(listener[0], listener.slice(1), { stdio: 'inherit' });
      child.once('error', () => resolve(-1));
      child.once('close', (code, signal) => resolve(signal ? -1 : code));
    });
    child = undefined;
    // Before the next listener, and before a failed generation parks.
    if (cgroup) await cleanJobCgroup(cgroup).catch(error => console.error(`Job process cleanup failed: ${error.code ?? error.message}`));
    // The listener removes these files only after successful ephemeral completion.
    // Failed/update/crash exits park as blocked; never retry a one-use identity.
    if (code !== 0 || await exists('.runner') || await exists('.credentials') || await exists('.credentials_rsaparams')) throw new Error('Generation did not finish');
    await fs.unlink(inflight);
    await state('ready');
  }
} catch {
  if (owned) await state('blocked').catch(() => {});
  console.error('Autoscale slot blocked; inspect local runner diagnostics. No generation will be replayed.');
  // Stay parked rather than let Restart=always replay work or continuously restart.
  while (!stopping) await sleep(1000);
} finally {
  if (release) await release();
}
