import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireControllerLock, controllerService } from '../lib/runnerctl-autoscale-service.mjs';
import { validateConfig, plan } from '../lib/runnerctl-autoscale.mjs';

test('default user services run continuous applying autoscaling and contain no token', () => {
  for (const platform of ['linux', 'darwin']) {
    const unit = controllerService({ root: '/example/runner kit', configPath: '/example/private.json', node: '/usr/bin/node', home: '/example/home', platform, envPath: '/usr/bin:/bin' });
    assert.ok(unit.content.includes('--watch'));
    assert.ok(unit.content.includes('--apply'));
    assert.ok(!unit.content.includes('RUNNER_AUTOSCALE_TOKEN'));
    assert.ok(platform === 'linux' ? unit.content.includes('WantedBy=default.target') : unit.content.includes('<key>RunAtLoad</key><true/>'));
    assert.ok(!unit.content.includes('svc.sh'));
  }
});
test('service paths are escaped for their own format without a shell', () => {
  const options = { root: '/example/a & b%dir/$root', configPath: '/example/a"b.json', node: '/usr/bin/node', home: '/example/home', envPath: '/usr/bin:/bin' };
  assert.ok(controllerService({ ...options, platform: 'linux' }).content.includes('b%%dir/$$root'));
  const dollars = controllerService({ ...options, home: '/example/$home', platform: 'linux' }).content;
  assert.ok(dollars.includes('HOME=/example/$home'));
  assert.ok(!dollars.includes('HOME=/example/$$home'));
  assert.ok(controllerService({ ...options, platform: 'darwin' }).content.includes('&amp;'));
  assert.throws(() => controllerService({ ...options, configPath: '/bad\npath' }));
});
test('controller lock excludes a live owner and recovers a dead owner on restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'controller-lock-'));
  try {
    const release = await acquireControllerLock(root);
    await assert.rejects(acquireControllerLock(root));
    await release();
    const exited = spawn(process.execPath, ['-e', '']);
    await once(exited, 'exit');
    await fs.mkdir(path.join(root, '.autoscale.lock'));
    await fs.writeFile(path.join(root, '.autoscale.lock/pid'), String(exited.pid));
    const releaseAgain = await acquireControllerLock(root);
    await releaseAgain();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('six existing baseline runners count toward the total maximum and share CPU quotas', () => {
  const c = validateConfig({ minRunners: 6, maxRunners: 16, scope: 'organization', target: 'example-org', repositories: ['example-org/repo'], labels: ['self-hosted'], runnerGroupId: 1,
    baselineRunners: Array.from({ length: 6 }, (_, i) => `baseline-${i}`), runners: Array.from({ length: 10 }, (_, i) => `burst-${i}`) });
  const local = new Map([...c.baselineRunners.map(name => [name, { active: true, phase: 'baseline' }]), ...c.runners.map(name => [name, { active: false, phase: 'ready' }])]);
  const runners = [...local.keys()].map(name => ({ name, busy: name.startsWith('baseline'), registered: name.startsWith('baseline') }));
  const host = { cpus: 16, load: 0.2, freeMemoryPercent: 50 };
  const p = plan(c, { runners, queued: 20 }, local, host, {}, 0);
  assert.equal(p.active, 6);
  assert.equal(p.start.length, 10);
  assert.equal(p.desired, 16);
  assert.equal(p.quota, 80);
  assert.ok(p.start.every(name => name.startsWith('burst')));
  const idle = plan(c, { runners: runners.map(r => ({ ...r, busy: false })), queued: 0 }, local, host, {}, 0);
  assert.equal(idle.start.length, 0);
  assert.equal('stop' in idle, false);
});

test('launchd dead agents report stopped, start without killing, and oversized quotas remain readable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launchd-state-'));
  const exec = (await import('node:util')).promisify((await import('node:child_process')).execFile);
  try {
    await fs.copyFile(new URL('../../overlay/svc.sh', import.meta.url), path.join(root, 'svc.sh'));
    await fs.writeFile(path.join(root, '.runner'), JSON.stringify({ agentName: 'test-slot', gitHubUrl: 'https://github.com/example-org' }));
    const label = 'actions.runner.example-org.test-slot';
    await fs.mkdir(path.join(root, 'agents'));
    await fs.writeFile(path.join(root, 'agents', label + '.plist'), 'test');
    await fs.writeFile(path.join(root, '.cpu-quota'), '999999');
    const stub = path.join(root, 'launchctl');
    await fs.writeFile(stub, `#!/bin/sh
if [ "$1" = list ]; then echo '- 1 ${label}'; else echo "$*" >> '${root}/calls'; fi
`, { mode: 0o700 });
    const env = { ...process.env, PATH: process.env.PATH + ':/opt/Program Files (x86)', HOME: path.join(root, 'home with spaces'), RUNNER_LAUNCHCTL_BIN: stub, RUNNER_LAUNCH_PATH: path.join(root, 'agents'), RUNNER_LAUNCHD_USER_HOME: root };
    const status = await exec('bash', [path.join(root, 'svc.sh'), 'status'], { env });
    assert.ok(status.stdout.includes('Stopped'));
    assert.ok(!status.stdout.includes('Started:'));
    assert.ok(status.stderr.includes('host ceiling'));
    await exec('bash', [path.join(root, 'svc.sh'), 'start'], { env });
    const calls = await fs.readFile(path.join(root, 'calls'), 'utf8');
    assert.match(calls, /kickstart gui\/\d+\/actions.runner/);
    assert.ok(!calls.includes('-k'));
    const template = await fs.readFile(new URL('../../overlay/bin/actions.runner.plist.template', import.meta.url), 'utf8');
    assert.match(template, /<key>KeepAlive<\/key>\s*<true\/>/);
    const unsafe = path.join(root, 'unsafe path');
    await fs.mkdir(unsafe);
    await fs.copyFile(path.join(root, 'svc.sh'), path.join(unsafe, 'svc.sh'));
    await assert.rejects(exec('bash', [path.join(unsafe, 'svc.sh'), 'status'], { env }), error => error.stderr.includes('Unsupported service path'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
