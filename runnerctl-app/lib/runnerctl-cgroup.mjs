import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// Capacity inside a resource-limited container (cgroup v2). A container's
// --cpus and --memory limits are invisible to os.availableParallelism(),
// os.totalmem(), /proc/meminfo, and the load average: those report the whole
// host, so a controller sized from them would plan for CPUs its slots can
// never use and react to load from other tenants. With "capacity": "cgroup"
// the controller reads the limits and usage of the cgroups that contain it.

const readText = file => readFileSync(file, 'utf8');

// The directories from this process's cgroup up to the namespace root.
export function cgroupChain({ root = '/sys/fs/cgroup', read = readText } = {}) {
  let relative = '/';
  try {
    const line = read('/proc/self/cgroup').split('\n').find(l => l.startsWith('0::'));
    if (line) relative = line.slice(3).trim() || '/';
  } catch { /* An unreadable membership falls back to the namespace root. */ }
  // A path outside this namespace shows as "/.." components; only the root is usable then.
  if (relative.split('/').includes('..')) relative = '/';
  const parts = relative.split('/').filter(Boolean);
  const chain = [];
  for (let i = parts.length; i >= 0; i--) chain.push(path.join(root, ...parts.slice(0, i)));
  return chain;
}

function tryRead(read, file) {
  try { return read(file).trim(); } catch { return null; }
}

export function parseCpuMax(text) {
  const [quota, period] = String(text ?? '').trim().split(/\s+/);
  const q = Number(quota), p = Number(period);
  if (quota === 'max' || !Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return null;
  return q / p;
}

export function parseMemoryMax(text) {
  const value = String(text ?? '').trim();
  if (value === 'max' || !/^\d+$/.test(value)) return null;
  const bytes = Number(value);
  return bytes > 0 ? bytes : null;
}

export function parseKeyed(text, key) {
  const match = new RegExp(`(?:^|\\s)${key}[ =](\\d+)`, 'm').exec(String(text ?? ''));
  return match ? Number(match[1]) : null;
}

// The tightest CPU and memory limits on the chain, and where each was found;
// usage is measured at the cgroup that sets the limit.
export function cgroupLimits({ root, read = readText } = {}) {
  let cpu = null, memory = null;
  for (const dir of cgroupChain({ root, read })) {
    const cpus = parseCpuMax(tryRead(read, path.join(dir, 'cpu.max')));
    if (cpus !== null && (cpu === null || cpus < cpu.cpus)) cpu = { cpus, dir };
    const bytes = parseMemoryMax(tryRead(read, path.join(dir, 'memory.max')));
    if (bytes !== null && (memory === null || bytes < memory.bytes)) memory = { bytes, dir };
  }
  return { cpu, memory };
}

// Sizing input for validateConfig: whole CPUs (at least one) and memory bytes,
// never above what the host itself reports.
export function cgroupHardware({ root, read = readText, hostCpus = os.availableParallelism(), hostMemory = os.totalmem() } = {}) {
  const { cpu, memory } = cgroupLimits({ root, read });
  return {
    cpus: Math.max(1, Math.min(hostCpus, cpu ? Math.floor(cpu.cpus) : hostCpus)),
    memoryBytes: Math.min(hostMemory, memory ? memory.bytes : hostMemory)
  };
}

function hostAvailableMemory(read) {
  const text = tryRead(read, '/proc/meminfo');
  const kib = Number(/^MemAvailable:\s+(\d+)/m.exec(text ?? '')?.[1]);
  return Number.isFinite(kib) ? kib * 1024 : null;
}

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Load per CPU inside the limit: the busy fraction of the CPU quota plus the
// fraction of time runnable tasks waited for a CPU (cpu.pressure "some").
// Like the load average per CPU, 1.0 means saturated and waiting work pushes
// it above 1, so lowLoad and highLoad keep their meaning. Memory is free when
// it is under the limit (reclaimable page cache counts as free) and the host
// still has it available.
export class CgroupSampler {
  constructor({ root, read = readText, now = () => performance.now(), sleep = sleepSync, hostCpus, hostMemory } = {}) {
    Object.assign(this, { root, read, now, sleep });
    this.hostCpus = hostCpus;
    this.hostMemory = hostMemory;
    this.previous = null;
  }

  counters(dir) {
    const usage = parseKeyed(tryRead(this.read, path.join(dir, 'cpu.stat')), 'usage_usec');
    const some = /^some .*?total=(\d+)/m.exec(tryRead(this.read, path.join(dir, 'cpu.pressure')) ?? '');
    return { at: this.now(), usage, stall: some ? Number(some[1]) : 0 };
  }

  sample() {
    const hostCpus = this.hostCpus ?? os.availableParallelism();
    const hostMemory = this.hostMemory ?? os.totalmem();
    const { cpu, memory } = cgroupLimits({ root: this.root, read: this.read });
    const cpus = Math.max(1, Math.min(hostCpus, cpu ? Math.floor(cpu.cpus) : hostCpus));
    const capacity = cpu ? Math.min(cpu.cpus, hostCpus) : hostCpus;
    const dir = cpu?.dir ?? cgroupChain({ root: this.root, read: this.read }).at(-1);

    // The first sample after start measures a short window instead of guessing.
    if (!this.previous || this.previous.dir !== dir) {
      this.previous = { dir, ...this.counters(dir) };
      this.sleep(250);
    }
    const current = { dir, ...this.counters(dir) };
    const wallUsec = (current.at - this.previous.at) * 1000;
    // Without cpu.stat (no cpu controller here), the load average is the fallback.
    let load = os.loadavg()[0] / cpus;
    if (current.usage !== null && this.previous.usage !== null && wallUsec > 0) {
      const busy = Math.max(0, current.usage - this.previous.usage) / (wallUsec * capacity);
      const stall = Math.max(0, current.stall - this.previous.stall) / wallUsec;
      load = Math.max(0, busy) + Math.min(1, Math.max(0, stall));
    }
    this.previous = current;

    const limit = Math.min(hostMemory, memory ? memory.bytes : hostMemory);
    const hostFree = hostAvailableMemory(this.read);
    let free = hostFree;
    if (memory) {
      const text = tryRead(this.read, path.join(memory.dir, 'memory.current'));
      const current = text === null ? NaN : Number(text);
      const reclaimable = parseKeyed(tryRead(this.read, path.join(memory.dir, 'memory.stat')), 'inactive_file') ?? 0;
      if (Number.isFinite(current)) {
        const underLimit = Math.max(0, limit - Math.max(0, current - reclaimable));
        free = hostFree === null ? underLimit : Math.min(underLimit, hostFree);
      } else free = null;
    }
    // Missing telemetry fails conservatively, like the host sampler.
    const freeMemoryPercent = free === null || !(limit > 0) ? 0 : Math.min(100, free / limit * 100);
    return { cpus, load, freeMemoryPercent };
  }
}
