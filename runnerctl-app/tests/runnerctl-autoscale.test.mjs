import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, githubClient, snapshot, plan, decodeJit, effectiveQuota, hardwareRunnerBounds } from '../lib/runnerctl-autoscale.mjs';

const config = (extra = {}) => validateConfig({ scope: 'organization', target: 'example-org',
  minRunners: 6, maxRunners: 16, labels: ['self-hosted', 'Linux', 'X64'], runnerGroupId: 1, repositories: ['example-org/example-repo'], runners: Array.from({ length: 16 }, (_, i) => `runner-${i + 1}`), ...extra });
function fixture(active = 6, busy = 0, queued = 10) {
  const c = config();
  const runners = c.runners.map((name, i) => ({ id: i + 1, name, status: i < active ? 'online' : 'offline', busy: i < busy,
    labels: [{ name: 'self-hosted' }, { name: 'Linux' }, { name: 'X64' }] }));
  const local = new Map(runners.map((r, i) => [r.name, { active: i < active, phase: 'ready', id: i + 1 }]));
  return { c, data: { runners, queued }, local, host: { cpus: 16, load: 0.2, freeMemoryPercent: 60 } };
}
test('scales six to sixteen when ten jobs wait behind six busy workers', () => {
  const f = fixture(6, 6, 10);
  const p = plan(f.c, f.data, f.local, f.host, {}, 0);
  assert.equal(p.start.length, 10);
  assert.equal(p.desired, 16);
  assert.equal(p.quota, 80);
});
test('idle workers already provide queue capacity', () => {
  const f = fixture(6, 0, 6);
  assert.equal(plan(f.c, f.data, f.local, f.host, {}, 0).start.length, 0);
});
test('heavy host reduces quotas without adding runners; hysteresis avoids flapping', () => {
  const f = fixture(16, 16, 50);
  const state = {};
  let p = plan(f.c, f.data, f.local, { ...f.host, load: 1.5 }, state, 0);
  assert.equal(p.quota, 30);
  assert.equal(p.start.length, 0);
  assert.equal('stop' in p, false);
  p = plan(f.c, f.data, f.local, { ...f.host, load: 0.8 }, state, 60000);
  assert.equal(p.quota, 30);
  assert.equal(plan(f.c, f.data, f.local, f.host, state, 120000).quota, 80);
});
test('memory pressure blocks growth even with low CPU load', () => {
  const f = fixture(6, 6);
  const p = plan(f.c, f.data, f.local, { ...f.host, freeMemoryPercent: 5 }, {}, 0);
  assert.equal(p.start.length, 0);
  assert.equal(p.pressure, true);
});
test('scale down never stops a listener even when GitHub claims it is idle', () => {
  const f = fixture(16, 0, 0);
  const p = plan(f.c, f.data, f.local, f.host, {}, 300000);
  assert.equal(p.retiring, 10);
  assert.equal(p.start.length, 0);
  assert.equal('stop' in p, false);
  // The same process can accept a job after this snapshot; no destructive action exists.
  f.data.runners[0].busy = true;
  assert.equal(plan(f.c, f.data, f.local, f.host, {}, 600000).retiring, 10);
});
test('completed slots are replenished only up to demand and never reuse a registration', () => {
  const f = fixture(0, 0, 0);
  assert.equal(plan(f.c, f.data, f.local, f.host, {}, 0).start.length, 6);
  f.data.runners[0].registered = true; // Server has not removed an old generation yet.
  const p = plan(f.c, f.data, f.local, f.host, {}, 0);
  assert.equal(p.start.length, 6);
  assert.ok(!p.start.includes('runner-1'));
});
test('validates account boundaries, bounds, duplicates, and unknown secret keys', () => {
  for (const extra of [{ token: 'do-not-store' }, { repositories: ['another-org/repo'] },
    { target: '../private' }, { runners: ['duplicate', 'duplicate'] }, { maxRunners: 17 },
    { lowLoad: 2 }, { intervalSeconds: 1 }, { pressureCpuBudgetPercent: 90 }, { minRunners: 0 }, { runnerGroupId: 0 }, { labels: [] }, { labels: ['Linux', 'linux'] }, { idleSeconds: 300 }]) {
    assert.throws(() => config(extra), /Invalid autoscale configuration/);
  }
  assert.equal(config({ scope: 'repository', target: 'example-org/example-repo' }).scope, 'repository');
});
test('GitHub client paginates and never follows credential-bearing redirects', async () => {
  const calls = [];
  const api = githubClient('test-credential', async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ total_count: 2, runners: [{ id: calls.length }] }) };
  });
  assert.equal((await api('/orgs/example-org/actions/runners', 'runners')).length, 2);
  assert.ok(calls[1].url.endsWith('page=2'));
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].url.startsWith('https://api.github.com/'));
  await assert.rejects(api('https://other.invalid', 'runners'), /Invalid API endpoint/);
});
test('API failures and truncation fail closed without leaking server details', async () => {
  for (const response of [
    { ok: false, status: 403, json: async () => ({ message: 'private-detail' }) },
    { ok: true, json: async () => ({ total_count: 1000, workflow_runs: [] }) },
    { ok: true, json: async () => ({ total_count: 10, workflow_runs: [] }) },
    { ok: true, json: async () => ({ workflow_runs: [] }) }
  ]) {
    const api = githubClient('test-credential', async () => response);
    await assert.rejects(api('/repos/example-org/example-repo/actions/runs', 'workflow_runs'), error => !error.message.includes('private-detail'));
  }
  const api = githubClient('test-credential', async () => { throw new Error('private-detail'); });
  await assert.rejects(api('/orgs/example-org/actions/runners', 'runners'), /^Error: GitHub request failed$/);
});
test('queue discovery includes jobs in running workflows and matches all labels', async () => {
  const f = fixture();
  const api = async (endpoint, key) => {
    if (key === 'runners') return f.data.runners;
    if (key === 'workflow_runs') return endpoint.includes('status=in_progress') ? [{ id: 1 }] : [];
    return [
      { id: 1, status: 'queued', labels: ['self-hosted', 'linux'] },
      { id: 2, status: 'queued', labels: ['self-hosted', 'macOS'] },
      { id: 3, status: 'in_progress', labels: ['self-hosted'] },
      { id: 4, status: 'queued', labels: [] },
      { id: 1, status: 'queued', labels: ['self-hosted', 'linux'] }
    ];
  };
  assert.equal((await snapshot(f.c, api, f.local)).queued, 1);
  f.data.runners[0].labels = [];
  assert.equal((await snapshot(f.c, api, f.local)).runners[0].unavailable, true);
});
test('missing GitHub row does not change the active local lifecycle', async () => {
  const f = fixture(16, 0, 0);
  const data = await snapshot(f.c, async (_endpoint, key) => key === 'runners' ? f.data.runners.slice(1) : [], f.local);
  assert.equal(plan(f.c, data, f.local, f.host, {}, 0).active, 16);
});

function jitResponse(name = 'runner-2', changes = {}) {
  const files = { '.runner': JSON.stringify({ agentId: 2, agentName: name, ephemeral: true,
    gitHubUrl: 'https://github.com/example-org', workFolder: '_work', ...changes }),
    '.credentials': '{"test":"private-jit-value"}', '.credentials_rsaparams': '{"test":"private-key-value"}' };
  return { runner: { id: 2, name }, encoded_jit_config: Buffer.from(JSON.stringify(Object.fromEntries(
    Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('base64')])))).toString('base64') };
}
test('JIT handoff rejects persistent registrations, foreign identities, and arbitrary file writes', () => {
  const c = config();
  for (const changes of [{ ephemeral: false }, { gitHubUrl: 'https://github.com/other-org' }, { agentId: 99 }, { workFolder: '../outside' }]) {
    assert.throws(() => decodeJit(c, 'runner-2', jitResponse('runner-2', changes)), /Invalid JIT identity/);
  }
  const data = jitResponse();
  data.encoded_jit_config = Buffer.from(JSON.stringify({ '../outside': 'private' })).toString('base64');
  assert.throws(() => decodeJit(c, 'runner-2', data), /Invalid JIT files/);
  assert.equal(JSON.parse(decodeJit(c, 'runner-2', jitResponse())['.runner']).disableUpdate, true);
});

test('real GitHub PascalCase JIT metadata is normalized before validation and handoff', () => {
  const data = jitResponse();
  const files = JSON.parse(Buffer.from(data.encoded_jit_config, 'base64').toString());
  const metadata = JSON.parse(Buffer.from(files['.runner'], 'base64').toString());
  files['.runner'] = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k[0].toUpperCase() + k.slice(1), typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v)])))).toString('base64');
  data.encoded_jit_config = Buffer.from(JSON.stringify(files)).toString('base64');
  const normalized = JSON.parse(decodeJit(config(), 'runner-2', data)['.runner']);
  assert.equal(normalized.ephemeral, true);
  assert.equal(normalized.agentId, 2);
  assert.equal(normalized.gitHubUrl, 'https://github.com/example-org');
});

test('CLI dry-run is read-only, applies quotas before starts, and strips service secrets', async () => {
  const { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, access } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { promisify } = await import('node:util');
  const exec = promisify((await import('node:child_process')).execFile);
  const root = await mkdtemp(join(tmpdir(), 'autoscale-test-'));
  try {
    await mkdir(join(root, 'runnerctl-app/bin'), { recursive: true });
    await mkdir(join(root, 'runnerctl-app/lib'), { recursive: true });
    for (const file of ['bin/runnerctl-autoscale.mjs', 'lib/runnerctl-core.mjs', 'lib/runnerctl-autoscale.mjs', 'lib/runnerctl-autoscale-service.mjs']) {
      await copyFile(new URL(`../${file}`, import.meta.url), join(root, 'runnerctl-app', file));
    }
    await mkdir(join(root, 'overlay'));
    await copyFile(new URL('../../overlay/autoscale-lock.mjs', import.meta.url), join(root, 'overlay/autoscale-lock.mjs'));
    const c = config({ minRunners: 1, maxRunners: 2, labels: ['self-hosted'], runners: ['runner-1', 'runner-2'] });
    await writeFile(join(root, 'autoscale.json'), JSON.stringify(c));
    const registry = [];
    for (let i = 1; i <= 2; i++) {
      const directory = join(root, `runner-${i}`);
      await mkdir(directory);
      registry.push(`runner-${i}\t${directory}`);
      await writeFile(join(directory, '.autoscale-slot.json'), JSON.stringify({ version: 1, agentName: `runner-${i}`, gitHubUrl: 'https://github.com/example-org' }));
      if (i === 1) await writeFile(join(directory, '.runner'), JSON.stringify({ agentName: 'runner-1', agentId: 1, ephemeral: true }));
      await writeFile(join(directory, '.service'), 'installed');
      await writeFile(join(directory, '.cpu-quota'), '50');
      await writeFile(join(directory, 'svc.sh'), `#!/bin/sh
if [ "$1" = status ]; then
  case "$PWD" in *runner-1) echo 'Started:';; *) if [ -f .autoscale-request.json ]; then echo 'Started:'; else echo 'Stopped'; fi;; esac
else
  [ -z "$RUNNER_AUTOSCALE_TOKEN" ] || exit 9
  [ -z "$UNRELATED_PRIVATE_SECRET" ] || exit 9
  echo "$1" >> ../operations
fi
`, { mode: 0o700 });
    }
    await writeFile(join(root, 'runners.tsv'), registry.join('\n'));
    await writeFile(join(root, 'mock-api.mjs'), `
      import { appendFile } from 'node:fs/promises';
      globalThis.fetch = async (url, options) => {
        if (process.env.AUTOSCALE_TEST_FAIL_API) return { ok: false, status: 403 };
        if (options.headers.Authorization !== 'Bearer private-test-value') throw new Error('auth missing');
        if (options.method === 'POST') {
          await appendFile(${JSON.stringify(join(root, 'operations'))}, 'register\\n');
          if (process.env.AUTOSCALE_TEST_FAIL_POST) throw new Error('private-server-error');
          return { ok: true, json: async () => (${JSON.stringify(jitResponse())}) };
        }
        const runners = [1].map(i => ({ id: i, name: 'runner-' + i, status: i === 1 ? 'online' : 'offline', busy: i === 1, labels: [{ name: 'self-hosted' }] }));
        const data = url.includes('/actions/runners') ? { runners, total_count: 1 } :
          url.includes('/jobs?') ? { jobs: [{ id: 1, status: 'queued', labels: ['self-hosted'] }], total_count: 1 } :
          { workflow_runs: url.includes('status=queued') ? [{ id: 1 }] : [], total_count: url.includes('status=queued') ? 1 : 0 };
        return { ok: true, json: async () => data };
      };
    `);
    const args = ['--import', join(root, 'mock-api.mjs'), join(root, 'runnerctl-app/bin/runnerctl-autoscale.mjs')];
    await mkdir(join(root, 'test-bin'));
    await writeFile(join(root, 'test-bin/systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const env = { ...process.env, PATH: join(root, 'test-bin') + ':' + process.env.PATH, RUNNER_AUTOSCALE_TOKEN: 'private-test-value', UNRELATED_PRIVATE_SECRET: 'hidden' };
    delete env.RUNNER_REGISTRY_PATH;
    const slotIdentity = join(root, 'runner-1/.autoscale-slot.json');
    const identity = await readFile(slotIdentity, 'utf8');
    await rm(slotIdentity);
    const isolated = await exec(process.execPath, [...args, '--apply', '--once'], { env });
    assert.equal(JSON.parse(isolated.stdout).unavailable, 1);
    await assert.rejects(exec(process.execPath, [...args, '--prepare'], { env }), error => error.stderr.includes('existing persistent runners will not be modified'));
    await rm(join(root, 'operations'), { force: true });
    await writeFile(slotIdentity, identity);
    const dry = await exec(process.execPath, [...args, '--dry-run'], { env });
    assert.equal(JSON.parse(dry.stdout).mode, 'dry-run');
    await assert.rejects(access(join(root, 'operations')));
    // Demand exceeds the floor; use thresholds high enough for any CI test host.
    c.lowLoad = 1000; c.highLoad = 2000; c.minFreeMemoryPercent = 1;
    await writeFile(join(root, 'autoscale.json'), JSON.stringify(c));
    const applied = await exec(process.execPath, [...args, '--apply', '--once'], { env });
    assert.equal(JSON.parse(applied.stdout).started, 1);
    const sequence = (await readFile(join(root, 'operations'), 'utf8')).trim().split('\n');
    assert.deepEqual(sequence.slice(-2), ['start', 'register']);
    assert.ok(sequence.slice(0, -2).every(v => v === 'set-cpu-limit'));
    assert.ok(!applied.stdout.includes('private-test-value'));
    assert.ok(!applied.stdout.includes('example-org'));
    const handoff = join(root, 'runner-2/.autoscale-request.json');
    const { stat } = await import('node:fs/promises');
    assert.equal((await stat(handoff)).mode & 0o777, 0o600);
    assert.ok((await readFile(handoff, 'utf8')).includes('private-jit-value'));
    assert.ok(!applied.stdout.includes('private-jit-value'));
    // Bare command actively controls the fleet and stays running by default.
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const daemon = spawn(process.execPath, args, { env });
    try {
      const [output] = await once(daemon.stdout, 'data');
      assert.equal(JSON.parse(output.toString()).mode, 'apply');
      assert.equal(daemon.exitCode, null);
    } finally {
      const done = once(daemon, 'exit');
      daemon.kill('SIGTERM');
      await done;
    }
    await assert.rejects(access(join(root, '.autoscale.lock')));
    await mkdir(join(root, '.autoscale.lock'));
    await writeFile(join(root, '.autoscale.lock/pid'), String(process.pid));
    await assert.rejects(exec(process.execPath, [...args, '--apply', '--once'], { env }), error => error.stderr.includes('lock exists'));
    await rm(join(root, '.autoscale.lock'), { recursive: true });
    await rm(handoff);
    await rm(join(root, 'runner-2/.autoscale-generation.json'));
    await assert.rejects(exec(process.execPath, [...args, '--apply', '--once'], { env: { ...env, AUTOSCALE_TEST_FAIL_POST: '1' } }),
      error => error.stderr.includes('GitHub registration failed') && !error.stderr.includes('private-server-error'));
    await access(join(root, 'runner-2/.autoscale-reservation.json'));
    const operations = await readFile(join(root, 'operations'), 'utf8');
    const blocked = await exec(process.execPath, [...args, '--apply', '--once'], { env });
    assert.equal(JSON.parse(blocked.stdout).unavailable, 1);
    assert.equal((await readFile(join(root, 'operations'), 'utf8')).split('register').length, operations.split('register').length); // No retry of an ambiguous creation.
    assert.ok(!operations.split('\n').includes('stop'));
    await rm(join(root, 'runner-2/.autoscale-reservation.json'));
    for (const name of ['runner-1', 'runner-2']) await writeFile(join(root, name, '.cpu-quota'), '1');
    const beforeOutage = await readFile(join(root, 'operations'), 'utf8');
    await assert.rejects(exec(process.execPath, [...args, '--apply', '--once'], { env: { ...env, AUTOSCALE_TEST_FAIL_API: '1' } }), error => {
      const report = JSON.parse(error.stdout);
      return report.mode === 'apply' && report.queueAvailable === false && report.cpuQuotaPercent > 1;
    });
    const duringOutage = (await readFile(join(root, 'operations'), 'utf8')).slice(beforeOutage.length).trim().split('\n');
    assert.deepEqual(duringOutage, ['set-cpu-limit', 'set-cpu-limit']);
    // A failed first candidate must not starve the next healthy candidate.
    const { cp, appendFile } = await import('node:fs/promises');
    await cp(join(root, 'runner-2'), join(root, 'runner-3'), { recursive: true });
    await writeFile(join(root, 'runner-3/.autoscale-slot.json'), JSON.stringify({ version: 1, agentName: 'runner-3', gitHubUrl: 'https://github.com/example-org' }));
    await appendFile(join(root, 'runners.tsv'), `\nrunner-3\t${join(root, 'runner-3')}`);
    const svc = join(root, 'runner-2/svc.sh');
    await writeFile(svc, (await readFile(svc, 'utf8')).replace('#!/bin/sh', '#!/bin/sh\n[ "$1" != start ] || exit 7'));
    c.minRunners = 3; c.maxRunners = 3; c.runners.push('runner-3');
    await writeFile(join(root, 'autoscale.json'), JSON.stringify(c));
    await appendFile(join(root, 'mock-api.mjs'), `
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        if (options.method === 'POST' && JSON.parse(options.body).name === 'runner-3') return { ok: true, json: async () => (${JSON.stringify(jitResponse('runner-3'))}) };
        return previousFetch(url, options);
      };
    `);
    const partial = await exec(process.execPath, [...args, '--once'], { env });
    assert.equal(JSON.parse(partial.stdout).started, 1);
    assert.equal(JSON.parse(partial.stdout).unavailable, 1);
    assert.ok(partial.stderr.includes('quarantined'));
    await access(join(root, 'runner-3/.autoscale-request.json'));
    // Preparation pins generated identities even when provisioning is verbose.
    const automatic = { ...c, minRunners: 1, maxRunners: 2 };
    delete automatic.runners;
    await writeFile(join(root, 'autoscale.json'), JSON.stringify(automatic));
    await writeFile(join(root, 'manage-runners.sh'), '#!/bin/sh\nhead -c 1100000 /dev/zero\n', { mode: 0o700 });
    await writeFile(join(root, 'test-bin/loginctl'), '#!/bin/sh\necho no\n', { mode: 0o700 });
    const prepared = await exec(process.execPath, [...args, '--prepare', '--no-enable'], { env });
    assert.ok(prepared.stderr.includes('Boot startup is not verified'));
    assert.deepEqual(JSON.parse(await readFile(join(root, 'autoscale.json'), 'utf8')).runners, ['ci-ephemeral-1', 'ci-ephemeral-2']);

  } finally { await rm(root, { recursive: true, force: true }); }
});

test('definite registration rejection permits retry; ambiguous responses do not', async () => {
  for (const status of [400, 401, 403, 404, 422, 429, 409, 500, 503]) {
    const api = githubClient('test-token', async () => ({ ok: false, status }));
    await assert.rejects(api.create(config(), 'runner-1'), error => {
      assert.equal(error.definiteRejection, ![409, 500, 503].includes(status));
      return true;
    });
  }
});
test('a recent scale-up does not delay growth for newly queued jobs', () => {
  const f = fixture(10, 10, 6);
  const p = plan(f.c, f.data, f.local, f.host, { lastScale: 0, grantedTarget: 10 }, 1000);
  assert.equal(p.start.length, 6);
});
test('load between thresholds without latched pressure still permits growth', () => {
  const f = fixture(10, 10, 3);
  const p = plan(f.c, f.data, f.local, { ...f.host, load: 0.83 }, {}, 0);
  assert.equal(p.pressure, false);
  assert.equal(p.start.length, 3);
});
test('torn paginated reads are retried and deduplicated instead of failing the poll', async () => {
  const row = id => ({ id, name: `runner-${id}` });
  const pages = [
    { total_count: 150, runners: Array.from({ length: 100 }, (_, i) => row(i + 1)) },
    { total_count: 150, runners: [] },
    { total_count: 150, runners: Array.from({ length: 100 }, (_, i) => row(i + 1)) },
    { total_count: 150, runners: Array.from({ length: 51 }, (_, i) => row(i + 100)) }
  ];
  const api = githubClient('test-token', async () => ({ ok: true, json: async () => pages.shift() }));
  const result = await api('/orgs/example-org/actions/runners', 'runners');
  assert.equal(result.length, 150);
  assert.equal(new Set(result.map(r => r.id)).size, 150);
  const empty = () => ({ ok: true, json: async () => ({ total_count: 5, runners: [] }) });
  let calls = 0;
  await assert.rejects(githubClient('test-token', async () => (calls++, empty()))('/orgs/example-org/actions/runners', 'runners'), /Incomplete/);
  assert.equal(calls, 3);
});
test('unavailable slots reserve capacity and cannot start', () => {
  const f = fixture(6, 6, 20);
  f.local.set('runner-7', { active: true, unavailable: true, phase: 'blocked' });
  const p = plan(f.c, f.data, f.local, f.host, {}, 0);
  assert.equal(p.active + p.start.length, 16);
  assert.ok(!p.start.includes('runner-7'));
});

test('live cgroup drift and unlimited caps require reapplication even when the saved quota matches policy', () => {
  assert.equal(effectiveQuota('Live CPU quota: 426000 100000', 426), 426);
  assert.ok(Number.isNaN(effectiveQuota('Live CPU quota: 160000 100000', 426)));
  assert.ok(Number.isNaN(effectiveQuota('Live CPU quota: max 100000', 426)));
  assert.ok(Number.isNaN(effectiveQuota('Started:', 426)));
});

test('automatic capacity is constrained by cores and memory, with host headroom', () => {
  const bounds = (cpus, gib) => hardwareRunnerBounds({ cpus, memoryBytes: gib * 2 ** 30 });
  assert.deepEqual(bounds(2, 4), { minRunners: 1, maxRunners: 1 });
  assert.deepEqual(bounds(8, 32), { minRunners: 1, maxRunners: 4 });
  assert.deepEqual(bounds(64, 16), { minRunners: 1, maxRunners: 3 });
  assert.deepEqual(bounds(32, 96), { minRunners: 4, maxRunners: 16 });
  assert.deepEqual(bounds(64, 256), { minRunners: 8, maxRunners: 32 });
});
test('automatic configuration generates host-sized slots and preserves explicit overrides', () => {
  const raw = { scope: 'organization', target: 'example-org', repositories: ['example-org/repo'], labels: ['self-hosted'], runnerGroupId: 1 };
  const hardware = { cpus: 64, memoryBytes: 256 * 2 ** 30 };
  const c = validateConfig(raw, hardware);
  assert.equal(c.minRunners, 8);
  assert.equal(c.maxRunners, 32);
  assert.equal(c.runners.length, 32);
  const resized = validateConfig({ ...raw, runners: c.runners }, { cpus: 2, memoryBytes: 4 * 2 ** 30 });
  assert.equal(resized.maxRunners, 1);
  assert.deepEqual(resized.runners, c.runners);
  assert.deepEqual(validateConfig({ ...raw, minRunners: 'auto', maxRunners: 'auto' }, hardware), c);
  const capped = validateConfig({ ...raw, runners: ['one', 'two'] }, hardware);
  assert.equal(capped.minRunners, 1);
  assert.equal(capped.maxRunners, 2);
  const explicit = validateConfig({ ...raw, minRunners: 2, maxRunners: 5 }, hardware);
  assert.equal(explicit.minRunners, 2);
  assert.equal(explicit.runners.length, 5);
  const baseline = validateConfig({ ...raw, baselineRunners: Array.from({ length: 10 }, (_, i) => `base-${i}`) }, hardware);
  assert.equal(baseline.minRunners, 10);
  assert.equal(baseline.runners.length, 22);
});
