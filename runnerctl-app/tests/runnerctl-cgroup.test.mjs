import test from 'node:test';
import assert from 'node:assert/strict';
import { cgroupChain, cgroupLimits, cgroupHardware, CgroupSampler, parseCpuMax, parseMemoryMax } from '../lib/runnerctl-cgroup.mjs';
import { validateConfig, configHardware, hostSample, cpuPolicy } from '../lib/runnerctl-autoscale.mjs';

const GiB = 2 ** 30;
const CONTROLLER = '/user.slice/user-2101.slice/user@2101.service/app.slice/runnerctl-autoscale-abc.service';

// A fake cgroup v2 tree: the container root sets the org limits; the
// controller sits several levels below it, as under systemd in a container.
function tree(files) {
  const all = { '/proc/self/cgroup': `0::${CONTROLLER}\n`, ...files };
  return file => {
    if (!(file in all)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return typeof all[file] === 'function' ? all[file]() : all[file];
  };
}

test('cgroup chain walks from the controller up to the namespace root', () => {
  const chain = cgroupChain({ root: '/cg', read: tree({}) });
  assert.equal(chain[0], `/cg${CONTROLLER}`);
  assert.equal(chain.at(-1), '/cg');
  assert.equal(chain.length, 6);
  // A membership outside this namespace is never followed.
  assert.deepEqual(cgroupChain({ root: '/cg', read: () => '0::/../../other\n' }), ['/cg']);
  assert.deepEqual(cgroupChain({ root: '/cg', read: () => { throw new Error('no'); } }), ['/cg']);
});

test('cpu.max and memory.max parse limits and treat max as unlimited', () => {
  assert.equal(parseCpuMax('800000 100000\n'), 8);
  assert.equal(parseCpuMax('250000 100000'), 2.5);
  assert.equal(parseCpuMax('max 100000'), null);
  assert.equal(parseCpuMax('garbage'), null);
  assert.equal(parseMemoryMax('25769803776\n'), 24 * GiB);
  assert.equal(parseMemoryMax('max'), null);
  assert.equal(parseMemoryMax('-1'), null);
});

test('the tightest limit on the chain wins and sizing never exceeds the host', () => {
  const read = tree({
    '/cg/cpu.max': '1200000 100000', '/cg/memory.max': String(24 * GiB),
    // A per-slice limit below the org's own is tighter.
    '/cg/user.slice/cpu.max': '800000 100000', '/cg/user.slice/memory.max': 'max'
  });
  const limits = cgroupLimits({ root: '/cg', read });
  assert.deepEqual(limits.cpu, { cpus: 8, dir: '/cg/user.slice' });
  assert.deepEqual(limits.memory, { bytes: 24 * GiB, dir: '/cg' });
  assert.deepEqual(cgroupHardware({ root: '/cg', read, hostCpus: 32, hostMemory: 89 * GiB }), { cpus: 8, memoryBytes: 24 * GiB });
  assert.deepEqual(cgroupHardware({ root: '/cg', read, hostCpus: 4, hostMemory: 16 * GiB }), { cpus: 4, memoryBytes: 16 * GiB });
  // A fractional quota still yields at least one whole CPU.
  assert.equal(cgroupHardware({ root: '/cg', read: tree({ '/cg/cpu.max': '50000 100000' }), hostCpus: 32, hostMemory: 8 * GiB }).cpus, 1);
  // No limits at all: the host.
  assert.deepEqual(cgroupHardware({ root: '/cg', read: tree({}), hostCpus: 32, hostMemory: 89 * GiB }), { cpus: 32, memoryBytes: 89 * GiB });
});

test('container sizing derives automatic bounds from the org limits, not the host', () => {
  const raw = { scope: 'organization', target: 'example-org', repositories: ['example-org/repo'], labels: ['self-hosted'],
    runnerGroupId: 1, capacity: 'cgroup' };
  const hardware = cgroupHardware({ root: '/cg', read: tree({ '/cg/cpu.max': '800000 100000', '/cg/memory.max': String(24 * GiB) }),
    hostCpus: 32, hostMemory: 89 * GiB });
  const c = validateConfig(raw, hardware, 'linux');
  // 8 CPUs / 2 = 4; (24 GiB - 4.8 GiB reserve) / 4 GiB = 4.
  assert.equal(c.maxRunners, 4);
  assert.equal(c.minCpuQuotaPercent, 100);
  assert.equal(c.capacity, 'cgroup');
  // The host default is unchanged and explicit.
  assert.equal(validateConfig({ ...raw, capacity: undefined }, { cpus: 32, memoryBytes: 89 * GiB }).capacity, 'host');
  assert.throws(() => validateConfig({ ...raw, capacity: 'container' }, hardware, 'linux'), /Invalid autoscale configuration/);
  assert.throws(() => validateConfig(raw, hardware, 'darwin'), /Invalid autoscale configuration/);
  assert.equal(configHardware({ ...raw, capacity: 'host' }), undefined);
  if (process.platform === 'linux') assert.deepEqual(configHardware(raw, { cgroup: () => hardware }), hardware);
});

test('container load is the quota busy fraction plus CPU waiting, and other tenants do not count', () => {
  let usage = 0, stall = 0, now = 0;
  const read = tree({
    '/cg/cpu.max': '400000 100000', '/cg/memory.max': String(8 * GiB),
    '/cg/cpu.stat': () => `usage_usec ${usage}\nuser_usec 1\nsystem_usec 1\n`,
    '/cg/cpu.pressure': () => `some avg10=0.00 avg60=0.00 avg300=0.00 total=${stall}\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`,
    '/cg/memory.current': String(6 * GiB), '/cg/memory.stat': `anon 1\ninactive_file ${2 * GiB}\n`,
    '/proc/meminfo': `MemTotal: ${89 * 1024 * 1024} kB\nMemAvailable: ${40 * 1024 * 1024} kB\n`
  });
  // The first sample measures its own short window.
  const sampler = new CgroupSampler({ root: '/cg', read, now: () => now, sleep: ms => { now += ms; usage += 4 * ms * 1000 / 2; },
    hostCpus: 32, hostMemory: 89 * GiB });
  const first = sampler.sample();
  assert.equal(first.cpus, 4);
  assert.equal(first.load, 0.5);
  // (8 - (6 - 2)) / 8 GiB free.
  assert.equal(first.freeMemoryPercent, 50);
  // Saturated for 20 s, with runnable tasks waiting half of it.
  now += 20000; usage += 4 * 20000 * 1000; stall += 10000 * 1000;
  const busy = sampler.sample();
  assert.equal(busy.load, 1.5);
  const c = validateConfig({ scope: 'organization', target: 'example-org', repositories: ['example-org/repo'], labels: ['self-hosted'],
    runnerGroupId: 1, runners: ['a', 'b'], capacity: 'cgroup', highLoad: 1.5, lowLoad: 1 }, { cpus: 4, memoryBytes: 8 * GiB }, 'linux');
  assert.equal(cpuPolicy(c, 2, busy, {}).pressure, true);
  // Idle: no usage and no waiting.
  now += 20000;
  assert.equal(sampler.sample().load, 0);
  // The host sampler routes container configs here.
  assert.equal(hostSample(c, { sampler: { sample: () => ({ cpus: 4, load: 0.25, freeMemoryPercent: 60 }) } }).load, 0.25);
});

test('container memory is bounded by what the host still has', () => {
  const read = tree({
    '/cg/memory.max': String(24 * GiB), '/cg/memory.current': String(4 * GiB), '/cg/memory.stat': 'inactive_file 0\n',
    '/cg/cpu.stat': 'usage_usec 0\n',
    '/proc/meminfo': `MemTotal: ${89 * 1024 * 1024} kB\nMemAvailable: ${6 * 1024 * 1024} kB\n`
  });
  const sample = new CgroupSampler({ root: '/cg', read, now: () => 0, sleep: () => {}, hostCpus: 32, hostMemory: 89 * GiB }).sample();
  assert.equal(sample.freeMemoryPercent, 25);
  // Unreadable usage fails conservatively.
  const blind = new CgroupSampler({ root: '/cg', read: tree({ '/cg/memory.max': String(GiB) }), now: () => 0, sleep: () => {}, hostCpus: 2, hostMemory: 8 * GiB });
  assert.equal(blind.sample().freeMemoryPercent, 0);
});
