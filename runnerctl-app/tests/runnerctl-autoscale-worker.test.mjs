import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { plan, validateConfig } from '../lib/runnerctl-autoscale.mjs';

async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error('Timed out waiting for local worker');
}
async function setup() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ephemeral-worker-'));
  const file = name => path.join(root, name);
  await fs.mkdir(file('bin'));
  await fs.copyFile(new URL('../../overlay/autoscale-lock.mjs', import.meta.url), file('bin/autoscale-lock.mjs'));
  await fs.copyFile(new URL('../../overlay/autoscale-worker.mjs', import.meta.url), file('bin/autoscale-worker.mjs'));
  await fs.writeFile(file('.autoscale-slot.json'), JSON.stringify({ agentName: 'test-slot', gitHubUrl: 'https://github.com/example-org' }));
  await fs.writeFile(file('bin/Runner.Listener'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync('starts', 'started\\n');
fs.writeFileSync('argv', JSON.stringify(process.argv));
fs.writeFileSync('accepted', 'yes');
const interval = setInterval(() => {
  if (fs.existsSync('finish')) {
    clearInterval(interval);
    for (const f of ['.runner', '.credentials', '.credentials_rsaparams', 'finish', 'accepted']) fs.unlinkSync(f);
    process.exit(0);
  }
  if (fs.existsSync('fail')) process.exit(1);
}, 20);
`, { mode: 0o700 });
  const children = [];
  const launch = () => {
    const child = spawn(process.execPath, ['bin/autoscale-worker.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    child.output = '';
    child.stdout.on('data', d => { child.output += d; });
    child.stderr.on('data', d => { child.output += d; });
    children.push(child);
    return child;
  };
  const phase = async p => {
    try { return JSON.parse(await fs.readFile(file('.autoscale-state.json'), 'utf8')).phase === p; }
    catch { return false; }
  };
  const exists = async name => fs.access(file(name)).then(() => true, () => false);
  const request = async (id = 1, ephemeral = true) => {
    const files = { '.runner': JSON.stringify({ agentName: 'test-slot', agentId: id, ephemeral, gitHubUrl: 'https://github.com/example-org' }),
      '.credentials': 'private-credential', '.credentials_rsaparams': 'private-key' };
    await fs.writeFile(file('.autoscale-request.tmp'), JSON.stringify(files), { mode: 0o600 });
    await fs.rename(file('.autoscale-request.tmp'), file('.autoscale-request.json'));
  };
  const cleanup = async () => {
    await fs.writeFile(file('finish'), 'yes');
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const done = once(child, 'exit');
        child.kill('SIGTERM');
        await done;
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  };
  return { root, file, launch, phase, exists, request, cleanup };
}

test('job assigned after idle snapshot finishes, deregisters, and parks without replay', { timeout: 15000 }, async () => {
  const f = await setup();
  try {
    const worker = f.launch();
    await until(() => f.phase('ready'));
    await f.request();
    await until(() => f.exists('accepted'));
    // GitHub still says idle while the local listener has just accepted a job.
    const c = validateConfig({ scope: 'organization', target: 'example-org', repositories: ['example-org/example-repo'],
      runners: ['test-slot', 'other-slot'], labels: ['self-hosted'], runnerGroupId: 1, minRunners: 1, maxRunners: 2 });
    const local = new Map(c.runners.map(name => [name, { active: true, phase: 'running' }]));
    const p = plan(c, { queued: 0, runners: c.runners.map(name => ({ name, busy: false })) }, local,
      { cpus: 16, load: 0.2, freeMemoryPercent: 50 }, {}, 0);
    assert.equal(p.retiring, 1);
    assert.equal('stop' in p, false);
    assert.equal(worker.exitCode, null);
    assert.equal(await f.phase('running'), true);
    for (const name of ['.runner', '.credentials', '.credentials_rsaparams']) {
      assert.equal((await fs.stat(f.file(name))).mode & 0o777, 0o600);
    }
    assert.ok(!(await fs.readFile(f.file('argv'), 'utf8')).includes('private-credential'));
    await fs.writeFile(f.file('finish'), 'yes');
    await until(() => f.phase('ready'));
    assert.equal(await f.exists('.autoscale-inflight.json'), false);
    assert.equal(await f.exists('.runner'), false);
    await sleep(1100);
    assert.equal(await fs.readFile(f.file('starts'), 'utf8'), 'started\n');
    assert.equal(worker.exitCode, null); // Service survives parked, so Restart=always cannot replay.
    await f.request(2);
    await until(() => f.exists('accepted'));
    assert.equal(await fs.readFile(f.file('starts'), 'utf8'), 'started\nstarted\n');
    assert.ok(!worker.output.includes('private-credential'));
  } finally { await f.cleanup(); }
});

test('failed generation remains blocked across supervisor restart and is never replayed', { timeout: 15000 }, async () => {
  const f = await setup();
  try {
    const worker = f.launch();
    await until(() => f.phase('ready'));
    await f.request();
    await until(() => f.exists('accepted'));
    await fs.writeFile(f.file('fail'), 'yes');
    await until(() => f.phase('blocked'));
    assert.equal(await f.exists('.autoscale-inflight.json'), true);
    const done = once(worker, 'exit');
    worker.kill('SIGTERM');
    await done;
    f.launch();
    await sleep(1100);
    assert.equal(await f.phase('blocked'), true);
    assert.equal(await fs.readFile(f.file('starts'), 'utf8'), 'started\n');
  } finally { await f.cleanup(); }
});

test('persistent handoff is rejected before a listener can start', { timeout: 10000 }, async () => {
  const f = await setup();
  try {
    f.launch();
    await until(() => f.phase('ready'));
    await f.request(1, false);
    await until(() => f.phase('blocked'));
    assert.equal(await f.exists('starts'), false);
  } finally { await f.cleanup(); }
});

test('a second supervisor cannot launch another listener for the same slot', { timeout: 10000 }, async () => {
  const f = await setup();
  try {
    f.launch();
    await until(() => f.phase('ready'));
    const duplicate = f.launch();
    await until(async () => duplicate.output.includes('blocked'));
    await f.request();
    await until(() => f.exists('accepted'));
    assert.equal(await fs.readFile(f.file('starts'), 'utf8'), 'started\n');
    assert.equal(await f.phase('running'), true);
  } finally { await f.cleanup(); }
});

test('a parked supervisor recovers after SIGKILL without stale-lock repair', { timeout: 10000 }, async () => {
  const f = await setup();
  try {
    const worker = f.launch();
    await until(() => f.phase('ready'));
    const done = once(worker, 'exit');
    worker.kill('SIGKILL');
    await done;
    f.launch();
    await f.request();
    await until(() => f.exists('accepted'));
    assert.equal(await fs.readFile(f.file('starts'), 'utf8'), 'started\n');
  } finally { await f.cleanup(); }
});

test('macOS limiter reloads quota without restarting or signaling its listener', { timeout: 10000 }, async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'limiter-reload-'));
  try {
    const source = await fs.readFile(new URL('../../overlay/runsvc.sh', import.meta.url), 'utf8');
    await fs.writeFile(path.join(root, '.cpu-quota'), '175');
    await fs.writeFile(path.join(root, 'limiter'), `#!/bin/bash
printf '%s\\n' "$*" >> events
trap 'exit 0' TERM INT
while true; do sleep 0.1; done
`, { mode: 0o700 });
    const script = source.slice(0, source.indexOf('ambient_started_hook=')) + `
RUNNER_CPULIMIT_BIN=./limiter
MACOS_CPU_QUOTA_PERCENT=175
sleep 8 &
PID=$!
start_macos_cpu_limiter
sleep 1.3
printf '40\\n' > .cpu-quota
sleep 1.5
kill -0 "$PID"
kill "$CPULIMIT_MONITOR_PID"
wait "$CPULIMIT_MONITOR_PID" || true
kill "$PID"
wait "$PID" || true
PID=""
CPULIMIT_MONITOR_PID=""
`;
    await fs.writeFile(path.join(root, 'test.sh'), script);
    const child = spawn('bash', ['test.sh'], { cwd: root, stdio: 'ignore' });
    assert.equal((await once(child, 'exit'))[0], 0);
    const events = (await fs.readFile(path.join(root, 'events'), 'utf8')).trim().split('\n');
    assert.equal(events.length, 2);
    assert.match(events[0], /^--limit 175 --include-children --pid \d+$/);
    assert.equal(events[1], events[0].replace('--limit 175', '--limit 40'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
