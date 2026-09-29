import os from 'node:os';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Only these deliberately constructed diagnostics may be printed by the CLI.
export class AutoscaleError extends Error {}

const fail = () => { throw new AutoscaleError('Invalid autoscale configuration; see autoscale.example.json'); };
// Capacity planning uses installed resources; transient pressure is handled by cpuPolicy.
export function hardwareRunnerBounds({ cpus = os.availableParallelism(), memoryBytes = os.totalmem() } = {}) {
  if (!Number.isSafeInteger(cpus) || cpus < 1 || !Number.isFinite(memoryBytes) || memoryBytes <= 0) fail();
  const GiB = 2 ** 30;
  const reserve = Math.max(2 * GiB, memoryBytes * 0.2);
  const maxRunners = Math.max(1, Math.min(Math.floor(cpus / 2), Math.floor((memoryBytes - reserve) / (4 * GiB))));
  return { minRunners: Math.max(1, Math.floor(maxRunners / 4)), maxRunners };
}
export function validateConfig(raw, hardware) {
  const bounds = hardwareRunnerBounds(hardware);
  const defaults = { minRunners: bounds.minRunners, maxRunners: bounds.maxRunners, intervalSeconds: 60,
    cooldownSeconds: 120, lowLoad: 0.6, highLoad: 1,
    minFreeMemoryPercent: 10, cpuBudgetPercent: 80, pressureCpuBudgetPercent: 30,
    minCpuQuotaPercent: 25, maxCpuQuotaPercent: 800 };
  const allowed = new Set([...Object.keys(defaults), 'scope', 'target', 'repositories', 'runners', 'labels', 'runnerGroupId', 'baselineRunners']);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !allowed.has(k))) fail();
  const c = { ...defaults, baselineRunners: [], ...raw };
  const automatic = key => raw[key] === undefined || raw[key] === 'auto';
  if (!Array.isArray(c.baselineRunners)) fail();
  if (automatic('maxRunners')) {
    c.maxRunners = Array.isArray(raw.runners) ? Math.min(bounds.maxRunners, raw.runners.length + c.baselineRunners.length) : bounds.maxRunners;
  }
  if (automatic('minRunners')) c.minRunners = Math.max(c.baselineRunners.length, Math.min(bounds.minRunners, Math.max(1, Math.floor(c.maxRunners / 4))));
  if (raw.runners === undefined) {
    if (!Number.isSafeInteger(c.maxRunners) || c.maxRunners < 1 || c.maxRunners > 10000) fail();
    c.runners = Array.from({ length: Math.max(0, c.maxRunners - c.baselineRunners.length) }, (_, i) => `ci-ephemeral-${i + 1}`);
  }
  const part = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
  const repo = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
  if (!['organization', 'repository'].includes(c.scope) || typeof c.target !== 'string' ||
      !(c.scope === 'organization' ? part : repo).test(c.target) || /YOUR_|CHANGE_ME/i.test(c.target)) fail();
  if (!Number.isSafeInteger(c.runnerGroupId) || c.runnerGroupId < 1 ||
      !Array.isArray(c.labels) || !c.labels.length || c.labels.length > 100 ||
      c.labels.some(l => typeof l !== 'string' || !part.test(l)) ||
      new Set(c.labels.map(l => l.toLowerCase())).size !== c.labels.length) fail();
  for (const key of ['repositories', 'runners']) {
    if (!Array.isArray(c[key]) || (!c[key].length && (key !== 'runners' || !c.baselineRunners.length)) || new Set(c[key]).size !== c[key].length ||
        c[key].some(v => typeof v !== 'string' || !(key === 'repositories' ? repo : part).test(v))) fail();
  }
  if (!Array.isArray(c.baselineRunners) || c.baselineRunners.some(n => typeof n !== 'string' || !part.test(n)) ||
      new Set([...c.runners, ...c.baselineRunners]).size !== c.runners.length + c.baselineRunners.length) fail();
  if (c.repositories.some(r => c.scope === 'repository' ? r.toLowerCase() !== c.target.toLowerCase() :
    r.split('/')[0].toLowerCase() !== c.target.toLowerCase())) fail();
  for (const key of Object.keys(defaults)) {
    if (!Number.isFinite(c[key]) || c[key] <= 0 || (!['lowLoad', 'highLoad'].includes(key) && !Number.isSafeInteger(c[key]))) fail();
  }
  if (c.minRunners > c.maxRunners || c.maxRunners > c.runners.length + c.baselineRunners.length || c.baselineRunners.length > c.minRunners || c.intervalSeconds < 15 ||
      c.lowLoad >= c.highLoad ||
      c.minCpuQuotaPercent > c.maxCpuQuotaPercent || c.pressureCpuBudgetPercent > c.cpuBudgetPercent ||
      [c.minFreeMemoryPercent, c.cpuBudgetPercent, c.pressureCpuBudgetPercent].some(v => v > 100)) fail();
  return c;
}

// Fixed API origin, no redirects, and no response bodies in errors or logs.
export function githubClient(token, fetchImpl = fetch) {
  if (!token || /[\r\n]/.test(token)) throw new AutoscaleError('GitHub authentication unavailable');
  const list = async function (endpoint, key) {
    if (!/^\/(repos|orgs)\/[A-Za-z0-9_./?=&-]+$/.test(endpoint)) throw new AutoscaleError('Invalid API endpoint');
    // Lists shift while runners register and retire; restart a torn read rather than drop the poll.
    for (let attempt = 1; ; attempt++) {
      try { return await listOnce(endpoint, key); }
      catch (error) { if (!error.inconsistent || attempt >= 3) throw error; }
    }
  };
  const listOnce = async function (endpoint, key) {
    const all = new Map();
    for (let page = 1; page <= 100; page++) {
      let response;
      try {
        response = await fetchImpl(`https://api.github.com${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(15000)
        });
      } catch { throw new AutoscaleError('GitHub request failed'); }
      if (!response.ok) throw new AutoscaleError(`GitHub request failed (HTTP ${response.status})`);
      let data;
      try { data = await response.json(); } catch { throw new AutoscaleError('Invalid GitHub response'); }
      if (!Array.isArray(data[key]) || !Number.isSafeInteger(data.total_count) || data.total_count < 0) throw new AutoscaleError('Invalid GitHub response');
      // Items shifted across a page boundary appear twice; keep one copy per id.
      for (const item of data[key]) all.set(Number.isSafeInteger(item?.id) ? item.id : Symbol(), item);
      // Filtered run searches have a 1,000-result ceiling. Never treat a truncated queue as empty.
      if (key === 'workflow_runs' && data.total_count >= 1000) throw new AutoscaleError('GitHub run search limit reached');
      if (all.size >= data.total_count) return [...all.values()];
      if (data[key].length === 0) throw Object.assign(new AutoscaleError('Incomplete GitHub response'), { inconsistent: true });
    }
    throw new AutoscaleError('GitHub pagination limit reached');
  };
  list.create = async (c, name) => {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${runnerEndpoint(c)}/generate-jitconfig`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify({ name, runner_group_id: c.runnerGroupId, labels: c.labels, work_folder: '_work' }),
        redirect: 'error', signal: AbortSignal.timeout(15000)
      });
    } catch { throw new AutoscaleError('GitHub registration failed; check for an orphan registration before retrying'); }
    if (!response.ok) {
      const error = new AutoscaleError(`GitHub registration failed (HTTP ${response.status})`);
      error.definiteRejection = [400, 401, 403, 404, 422, 429].includes(response.status);
      throw error;
    }
    try { return decodeJit(c, name, await response.json()); }
    catch { throw new AutoscaleError('Invalid ephemeral registration response'); }
  };
  return list;
}

export function runnerEndpoint(c) {
  return c.scope === 'organization' ? `/orgs/${c.target}/actions/runners` : `/repos/${c.target}/actions/runners`;
}

export function decodeJit(c, name, data) {
  if (data.runner?.name !== name || !Number.isSafeInteger(data.runner?.id) || typeof data.encoded_jit_config !== 'string') throw new AutoscaleError('Invalid JIT response');
  const encoded = JSON.parse(Buffer.from(data.encoded_jit_config, 'base64').toString('utf8'));
  const keys = ['.runner', '.credentials', '.credentials_rsaparams'];
  if (Object.keys(encoded).length !== keys.length || keys.some(k => typeof encoded[k] !== 'string')) throw new AutoscaleError('Invalid JIT files');
  const files = Object.fromEntries(keys.map(k => [k, Buffer.from(encoded[k], 'base64').toString('utf8').replace(/^\uFEFF/, '')]));
  // GitHub's JIT payload uses PascalCase; on-disk runner config also accepts camelCase.
  const rawMetadata = JSON.parse(files['.runner']);
  const entries = Object.entries(rawMetadata).map(([k, v]) => [k[0].toLowerCase() + k.slice(1), v]);
  if (new Set(entries.map(([k]) => k)).size !== entries.length) throw new AutoscaleError('Ambiguous JIT identity');
  const metadata = Object.fromEntries(entries);
  for (const key of ['agentId', 'poolId']) {
    if (typeof metadata[key] === 'string' && /^\d+$/.test(metadata[key])) metadata[key] = Number(metadata[key]);
  }
  for (const key of ['ephemeral', 'disableUpdate', 'useV2Flow']) {
    if (typeof metadata[key] === 'string' && /^(true|false)$/i.test(metadata[key])) metadata[key] = metadata[key].toLowerCase() === 'true';
  }
  if (metadata.ephemeral !== true || metadata.agentName !== name || metadata.agentId !== data.runner.id ||
      metadata.workFolder !== '_work' || metadata.gitHubUrl?.replace(/\/+$/, '').toLowerCase() !== `https://github.com/${c.target}`.toLowerCase()) throw new AutoscaleError('Invalid JIT identity');
  // Update only between generations by preparing the kit; an updater exit must not replay JIT credentials.
  metadata.disableUpdate = true;
  files['.runner'] = JSON.stringify(metadata);
  return files;
}

export async function snapshot(c, api, local) {
  const remote = await api(runnerEndpoint(c), 'runners');
  const runners = [...c.baselineRunners, ...c.runners].map(name => {
    const matches = remote.filter(r => r.name === name);
    const slot = local.get(name);
    if (slot.unavailable || matches.length > 1) return { name, registered: true, unavailable: true, busy: false };
    const r = matches[0];
    if (slot.baseline && !r) return { name, registered: true, unavailable: true, busy: false };
    if (r && (typeof r.busy !== 'boolean' || !['online', 'offline'].includes(r.status) ||
        !Number.isSafeInteger(r.id) || r.id !== slot.id || !Array.isArray(r.labels) ||
        r.labels.some(l => typeof l.name !== 'string') ||
        c.labels.some(l => !r.labels.some(v => v.name.toLowerCase() === l.toLowerCase())))) {
      return { name, registered: true, unavailable: true, busy: false };
    }
    return { name, busy: slot.active && r?.busy === true, registered: !!r };
  });
  const eligible = new Set(c.labels.map(l => l.toLowerCase()));
  let queued = 0;
  for (const repo of c.repositories) {
    const runs = new Map();
    for (const status of ['queued', 'in_progress', 'pending', 'waiting', 'requested']) {
      for (const run of await api(`/repos/${repo}/actions/runs?status=${status}`, 'workflow_runs')) {
        if (!Number.isSafeInteger(run.id)) throw new AutoscaleError('Invalid workflow run');
        runs.set(run.id, run);
      }
    }
    const jobs = new Set();
    for (const run of runs.values()) {
      for (const job of await api(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest`, 'jobs')) {
        if (!Number.isSafeInteger(job.id) || typeof job.status !== 'string' || !Array.isArray(job.labels) ||
            job.labels.some(l => typeof l !== 'string')) throw new AutoscaleError('Invalid workflow job');
        if (!jobs.has(job.id) && job.status === 'queued' && job.labels.length &&
            job.labels.every(l => eligible.has(l.toLowerCase()))) queued++;
        jobs.add(job.id);
      }
    }
  }
  return { runners, queued };
}

export function hostSample() {
  const cpus = os.availableParallelism();
  let freeMemoryPercent;
  try {
    if (process.platform === 'linux') {
      const text = readFileSync('/proc/meminfo', 'utf8');
      freeMemoryPercent = Number(/^MemAvailable:\s+(\d+)/m.exec(text)?.[1]) / Number(/^MemTotal:\s+(\d+)/m.exec(text)?.[1]) * 100;
    } else if (process.platform === 'darwin') {
      const text = execFileSync('/usr/bin/memory_pressure', ['-Q'], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
      freeMemoryPercent = Number(/System-wide memory free percentage:\s*([\d.]+)%/.exec(text)?.[1]);
    }
  } catch { /* Fail conservatively if available-memory telemetry is unavailable. */ }
  if (!Number.isFinite(freeMemoryPercent)) freeMemoryPercent = 0;
  return { cpus, load: os.loadavg()[0] / cpus, freeMemoryPercent };
}

export function cpuPolicy(c, count, host, state) {
  if (![host.cpus, host.load, host.freeMemoryPercent].every(Number.isFinite) || host.cpus < 1 || host.load < 0) throw new AutoscaleError('Host metrics unavailable');
  const pressure = host.load >= c.highLoad || host.freeMemoryPercent < c.minFreeMemoryPercent;
  const free = host.load <= c.lowLoad && host.freeMemoryPercent >= c.minFreeMemoryPercent;
  if (pressure) state.pressure = true;
  else if (free) state.pressure = false;
  const budget = state.pressure ? c.pressureCpuBudgetPercent : c.cpuBudgetPercent;
  const quota = Math.max(1, Math.min(c.maxCpuQuotaPercent, host.cpus * 100,
    Math.max(c.minCpuQuotaPercent, Math.floor(host.cpus * budget / Math.max(1, count)))));
  return { pressure: !!state.pressure, free, quota };
}

export function plan(c, { runners, queued }, local, host, state, now) {
  if (![host.cpus, host.load, host.freeMemoryPercent].every(Number.isFinite) || host.cpus < 1 || host.load < 0) {
    throw new AutoscaleError('Host metrics unavailable');
  }
  // Local lifecycle files are authoritative. A missing/stale GitHub row never means it is safe to stop a process.
  const active = runners.filter(r => local.get(r.name).active);
  const busy = runners.filter(r => r.busy).length;
  let desired = Math.max(c.minRunners, Math.min(c.maxRunners, busy + queued));
  // Runner jobs raise host load themselves, so only latched pressure (not "not idle") blocks growth.
  const { pressure } = cpuPolicy(c, active.length, host, state);
  if (pressure && desired > active.length) desired = Math.max(c.minRunners, active.length);
  // Ephemeral listeners are consumed per job; delaying growth only leaves queued jobs waiting.
  const target = desired;
  const start = runners.filter(r => !r.unavailable && !local.get(r.name).unavailable && !local.get(r.name).active && local.get(r.name).phase === 'ready' && !r.registered)
    .slice(0, Math.max(0, target - active.length));
  const count = Math.max(1, active.length + start.length);
  const { quota } = cpuPolicy(c, count, host, state);
  return { queued, active: active.length, busy, desired, pressure: !!state.pressure, quota,
    start: start.map(r => r.name), retiring: Math.max(0, active.length - desired) };
}

export function effectiveQuota(status, savedQuota) {
  const match = /^Live CPU quota: (max|[0-9]+) ([0-9]+)$/m.exec(status);
  if (!match || match[1] === 'max' || Number(match[2]) < 1) return NaN;
  const quota = Number(match[1]) / Number(match[2]) * 100;
  // A stale saved quota also needs repair, even if the live cap happens to match policy.
  return Math.abs(quota - savedQuota) < 0.001 ? savedQuota : NaN;
}
