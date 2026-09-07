// A local slot accepts one credential handoff at a time. It never kills a listener
// to reduce capacity, and never reuses a consumed ephemeral registration.
import { acquireLock } from './autoscale-lock.mjs';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
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
  await state('ready');
  while (!stopping) {
    if (!await exists(request)) { await sleep(1000); continue; }
    await fs.rename(request, inflight);
    await state('running');
    const files = JSON.parse(await fs.readFile(inflight, 'utf8'));
    const allowed = ['.runner', '.credentials', '.credentials_rsaparams'];
    if (Object.keys(files).length !== 3 || allowed.some(k => typeof files[k] !== 'string')) throw new Error('Invalid handoff');
    const metadata = JSON.parse(files['.runner']);
    const slot = JSON.parse(await fs.readFile('.autoscale-slot.json', 'utf8'));
    if (metadata.ephemeral !== true || metadata.agentName !== slot.agentName ||
        metadata.gitHubUrl?.replace(/\/+$/, '').toLowerCase() !== slot.gitHubUrl.replace(/\/+$/, '').toLowerCase()) throw new Error('Invalid identity');
    for (const name of allowed) await fs.writeFile(name, files[name], { mode: 0o600, flag: 'wx' });
    // The runner reads its private config files: no credentials in argv or environment.
    const code = await new Promise(resolve => {
      child = spawn('./bin/Runner.Listener', ['run', '--startuptype', 'service'], { stdio: 'inherit' });
      child.once('error', () => resolve(-1));
      child.once('close', (code, signal) => resolve(signal ? -1 : code));
    });
    child = undefined;
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
