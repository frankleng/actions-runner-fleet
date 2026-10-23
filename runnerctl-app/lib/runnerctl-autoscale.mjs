import os from 'node:os';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { windowsLoadPerCpu } from './runnerctl-platform.mjs';

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
// The automatic per-runner CPU floor: an eighth of the host, between one and
// four CPUs. A job never crawls on a sliver of a CPU, and one runner still
// cannot take the whole machine.
export function hardwareMinCpuQuota(cpus = os.availableParallelism()) {
  if (!Number.isSafeInteger(cpus) || cpus < 1) fail();
  return Math.min(400, Math.max(100, Math.floor(cpus * 100 / 8)));
}
export function validateConfig(raw, hardware) {
  const bounds = hardwareRunnerBounds(hardware);
  const defaults = { minRunners: bounds.minRunners, maxRunners: bounds.maxRunners, intervalSeconds: 60,
    cooldownSeconds: 120, lowLoad: 0.6, highLoad: 1,
    minFreeMemoryPercent: 10, cpuBudgetPercent: 80, pressureCpuBudgetPercent: 30,
    minCpuQuotaPercent: hardwareMinCpuQuota(hardware?.cpus), maxCpuQuotaPercent: 800, pressureQueueGraceSeconds: 60 };
  const allowed = new Set([...Object.keys(defaults), 'scope', 'target', 'repositories', 'runners', 'labels', 'runnerGroupId', 'baselineRunners']);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !allowed.has(k))) fail();
  const c = { ...defaults, baselineRunners: [], ...raw };
  const automatic = key => raw[key] === undefined || raw[key] === 'auto';
  if (!Array.isArray(c.baselineRunners)) fail();
  if (automatic('maxRunners')) {
    c.maxRunners = Array.isArray(raw.runners) ? Math.min(bounds.maxRunners, raw.runners.length + c.baselineRunners.length) : bounds.maxRunners;
  }
  if (automatic('minRunners')) c.minRunners = Math.max(c.baselineRunners.length, Math.min(bounds.minRunners, Math.max(1, Math.floor(c.maxRunners / 4))));
  // An explicit lower ceiling wins over the automatic floor.
  if (automatic('minCpuQuotaPercent')) c.minCpuQuotaPercent = Math.min(defaults.minCpuQuotaPercent, Number.isSafeInteger(c.maxCpuQuotaPercent) ? c.maxCpuQuotaPercent : defaults.minCpuQuotaPercent);
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

// Unchanged pages answer 304, which GitHub does not charge against the rate
// limit; a poll then costs only the lists that actually moved.
const ETAG_CACHE_LIMIT = 1000;
function rememberPage(etags, url, etag, data) {
  etags.delete(url);
  etags.set(url, { etag, data });
  while (etags.size > ETAG_CACHE_LIMIT) etags.delete(etags.keys().next().value);
}

// Failed GitHub calls carry a kind for the health state: auth (401, or 403
// that is not a rate limit), rate-limit, http, network, or invalid.
function githubError(message, githubKind, status) {
  return Object.assign(new AutoscaleError(message), { githubKind, ...(status ? { status } : {}) });
}
function httpFailure(message, response) {
  const status = response.status;
  const header = name => response.headers?.get?.(name);
  const rateLimited = status === 429 || (status === 403 && (header('x-ratelimit-remaining') === '0' || header('retry-after') != null));
  const kind = rateLimited ? 'rate-limit' : [401, 403].includes(status) ? 'auth' : 'http';
  return githubError(message, kind, status);
}
/** The recorded failure for a poll error, or null when it did not come from GitHub. */
export function githubFailure(error) {
  if (!(error instanceof AutoscaleError) || !error.githubKind) return null;
  return { kind: error.githubKind, ...(error.status ? { status: error.status } : {}) };
}

// Fixed API origin, no redirects, and no response bodies in errors or logs.
// `etags` outlives a poll's client so later polls can revalidate its pages.
export function githubClient(token, fetchImpl = fetch, etags = new Map()) {
  if (!token || /[\r\n]/.test(token)) throw githubError('GitHub authentication unavailable', 'no-token');
  // Every response, rejected ones included, reports the token's budget.
  const noteRate = response => {
    const remaining = Number(response.headers?.get?.('x-ratelimit-remaining') ?? NaN);
    if (Number.isFinite(remaining) && remaining <= list.rate.remaining) {
      list.rate.remaining = remaining;
      list.rate.reset = Number(response.headers?.get?.('x-ratelimit-reset') ?? NaN);
    }
  };
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
      const url = `https://api.github.com${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`;
      const cached = etags.get(url);
      let response;
      try {
        response = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28', ...(cached ? { 'If-None-Match': cached.etag } : {}) },
          redirect: 'error', signal: AbortSignal.timeout(15000)
        });
      } catch { throw githubError('GitHub request failed', 'network'); }
      noteRate(response);
      let data;
      if (response.status === 304 && cached) {
        data = cached.data;
        rememberPage(etags, url, cached.etag, data);
      } else {
        if (!response.ok) throw httpFailure(`GitHub request failed (HTTP ${response.status})`, response);
        try { data = await response.json(); } catch { throw githubError('Invalid GitHub response', 'invalid'); }
        const etag = response.headers?.get?.('etag');
        if (etag) rememberPage(etags, url, etag, data);
      }
      if (!Array.isArray(data[key]) || !Number.isSafeInteger(data.total_count) || data.total_count < 0) throw githubError('Invalid GitHub response', 'invalid');
      // Items shifted across a page boundary appear twice; keep one copy per id.
      for (const item of data[key]) all.set(Number.isSafeInteger(item?.id) ? item.id : Symbol(), item);
      // Filtered run searches have a 1,000-result ceiling. Never treat a truncated queue as empty.
      if (key === 'workflow_runs' && data.total_count >= 1000) throw new AutoscaleError('GitHub run search limit reached');
      if (all.size >= data.total_count) return [...all.values()];
      if (data[key].length === 0) throw Object.assign(new AutoscaleError('Incomplete GitHub response'), { inconsistent: true });
    }
    throw new AutoscaleError('GitHub pagination limit reached');
  };
  // Lowest rate-limit remainder this client saw, with its reset time in epoch seconds.
  list.rate = { remaining: Infinity, reset: NaN };
  list.create = async (c, name) => {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${runnerEndpoint(c)}/generate-jitconfig`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify({ name, runner_group_id: c.runnerGroupId, labels: c.labels, work_folder: '_work' }),
        redirect: 'error', signal: AbortSignal.timeout(15000)
      });
    } catch { throw githubError('GitHub registration failed; check for an orphan registration before retrying', 'network'); }
    noteRate(response);
    if (!response.ok) {
      const error = httpFailure(`GitHub registration failed (HTTP ${response.status})`, response);
      error.definiteRejection = [400, 401, 403, 404, 422, 429].includes(response.status);
      throw error;
    }
    try { return decodeJit(c, name, await response.json()); }
    catch { throw new AutoscaleError('Invalid ephemeral registration response'); }
  };
  list.remove = async (c, id) => {
    if (!Number.isSafeInteger(id) || id < 1) throw new AutoscaleError('Invalid runner id');
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${runnerEndpoint(c)}/${id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(15000)
      });
    } catch { throw githubError('GitHub runner removal failed', 'network'); }
    noteRate(response);
    // Already gone is the outcome we wanted.
    if (!response.ok && response.status !== 404) throw httpFailure(`GitHub runner removal failed (HTTP ${response.status})`, response);
  };
  return list;
}

// An ambiguous registration POST (for example HTTP 500) may or may not have
// created a runner. Its credentials were never received, so such a runner can
// never come online: an offline idle match is an inert orphan, and no match
// after a grace period for GitHub's list to catch up means nothing was created.
export const RESERVATION_GRACE_MS = 10 * 60 * 1000;
export function reservationDecision(name, remote, ageMs, graceMs = RESERVATION_GRACE_MS) {
  const matches = remote.filter(r => r?.name === name);
  if (matches.length === 0) return { action: ageMs >= graceMs ? 'clear' : 'wait' };
  const [r] = matches;
  if (matches.length === 1 && Number.isSafeInteger(r.id) && r.status === 'offline' && r.busy === false) return { action: 'delete', id: r.id };
  // Online, busy, or duplicated: something else holds this name. Stay blocked.
  return { action: 'keep' };
}

export function runnerEndpoint(c) {
  return c.scope === 'organization' ? `/orgs/${c.target}/actions/runners` : `/repos/${c.target}/actions/runners`;
}

// Pool slots register into the configured group, so listing only that group
// finds every slot in one page even when the organization holds hundreds of
// unrelated registrations elsewhere.
export function runnerListEndpoint(c) {
  return c.scope === 'organization' ? `/orgs/${c.target}/actions/runner-groups/${c.runnerGroupId}/runners` : runnerEndpoint(c);
}

// Overlaps a poll's GitHub reads instead of issuing them one by one, while
// staying far below GitHub's limit on concurrent requests. Nested calls share
// `abort`: the first failure anywhere stops every level from starting new reads,
// and each level settles what is in flight before rejecting, so no request
// outlives the poll that issued it.
async function mapLimit(items, limit, fn, abort = { failed: false }) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !abort.failed) {
      const i = next++;
      try { results[i] = await fn(items[i]); }
      catch (error) {
        if (!abort.failed) Object.assign(abort, { failed: true, error });
      }
    }
  }));
  // Results are partial once any branch failed; report that branch's error.
  if (abort.failed) throw abort.error;
  return results;
}

// The token is usually the operator's own gh login, shared with everything
// else they run. Near its hourly limit, read GitHub at most once a minute; once
// it is spent, wait for GitHub's reset instead of polling into rejections.
// Returns the earliest time (epoch ms) of the next GitHub read; local CPU
// control keeps its own interval meanwhile.
export const RATE_FLOOR = 500;
export function nextGithubPollAt(rate, nowMs) {
  const remaining = rate?.remaining ?? Infinity;
  if (remaining <= 0 && Number.isFinite(rate.reset)) return Math.min(nowMs + 3600000, Math.max(nowMs, rate.reset * 1000 + 1000));
  return remaining < RATE_FLOOR ? nowMs + 60000 : nowMs;
}
const RUN_STATUSES = ['queued', 'in_progress', 'pending', 'waiting', 'requested'];

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
  const remote = await api(runnerListEndpoint(c), 'runners');
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
  // When each matching queued job was created; null when GitHub omits it.
  const queuedAt = [];
  const abort = { failed: false };
  await mapLimit(c.repositories, 4, async repo => {
    const runs = new Map();
    const lists = await mapLimit(RUN_STATUSES, RUN_STATUSES.length, status => api(`/repos/${repo}/actions/runs?status=${status}`, 'workflow_runs'), abort);
    for (const run of lists.flat()) {
      if (!Number.isSafeInteger(run.id)) throw new AutoscaleError('Invalid workflow run');
      runs.set(run.id, run);
    }
    const jobs = new Set();
    const jobLists = await mapLimit([...runs.values()], 4, run => api(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest`, 'jobs'), abort);
    for (const job of jobLists.flat()) {
      if (!Number.isSafeInteger(job.id) || typeof job.status !== 'string' || !Array.isArray(job.labels) ||
          job.labels.some(l => typeof l !== 'string')) throw new AutoscaleError('Invalid workflow job');
      if (!jobs.has(job.id) && job.status === 'queued' && job.labels.length &&
          job.labels.every(l => eligible.has(l.toLowerCase()))) {
        const created = Date.parse(job.created_at);
        queuedAt.push(Number.isFinite(created) ? created : null);
      }
      jobs.add(job.id);
    }
  }, abort);
  // Pool runners GitHub reports online; health alerts when jobs queue with none.
  const names = new Set([...c.baselineRunners, ...c.runners]);
  const online = remote.filter(r => names.has(r?.name) && r.status === 'online').length;
  return { runners, queued: queuedAt.length, queuedAt, online };
}

export function hostSample() {
  const cpus = os.availableParallelism();
  // Windows reports available physical memory directly and has no load average.
  if (process.platform === 'win32') return { cpus, load: windowsLoadPerCpu(), freeMemoryPercent: os.freemem() / os.totalmem() * 100 };
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

// The local CPU step runs before GitHub is read each poll, and alone while
// reads are paused. It reuses the last poll's working count only while that is
// recent and never above the slots active now; otherwise every active slot
// shares the budget, so finished or newly busy runners are never mis-sized for
// long.
export function localSharing(c, state, active, now) {
  const recent = Number.isFinite(state.sharingAt) && now - state.sharingAt <= 3 * c.intervalSeconds * 1000;
  return Math.max(1, recent ? Math.min(state.sharing, active) : active);
}

export function plan(c, { runners, queued, queuedAt = [] }, local, host, state, now) {
  if (![host.cpus, host.load, host.freeMemoryPercent].every(Number.isFinite) || host.cpus < 1 || host.load < 0) {
    throw new AutoscaleError('Host metrics unavailable');
  }
  // Local lifecycle files are authoritative. A missing/stale GitHub row never means it is safe to stop a process.
  const active = runners.filter(r => local.get(r.name).active);
  const busy = runners.filter(r => r.busy).length;
  let desired = Math.max(c.minRunners, Math.min(c.maxRunners, busy + queued));
  // Runner jobs raise host load themselves, so only latched pressure (not "not idle") holds growth back.
  const { pressure } = cpuPolicy(c, active.length, host, state);
  // Under CPU pressure a fresh job waits one grace period for the host to
  // recover, then gets a runner anyway: contention only slows a job, while a
  // job with no runner never starts. Unknown creation times count as fresh.
  const waiting = queuedAt.filter(t => t !== null && now - t >= c.pressureQueueGraceSeconds * 1000).length;
  if (pressure && desired > active.length) {
    desired = Math.max(c.minRunners, active.length, Math.min(c.maxRunners, busy + waiting));
  }
  // Low memory still blocks growth outright: an out-of-memory kill fails jobs already running.
  if (host.freeMemoryPercent < c.minFreeMemoryPercent && desired > active.length) desired = Math.max(c.minRunners, active.length);
  // Ephemeral listeners are consumed per job; delaying growth only leaves queued jobs waiting.
  const target = desired;
  const start = runners.filter(r => !r.unavailable && !local.get(r.name).unavailable && !local.get(r.name).active && local.get(r.name).phase === 'ready' && !r.registered)
    .slice(0, Math.max(0, target - active.length));
  // The budget is shared by the runners expected to work this interval: busy
  // ones plus those about to take queued jobs. Idle warm listeners use no CPU,
  // and counting them shrank every job's quota (a 16-slot pool under pressure
  // left 0.6 CPU per job and timed out a five-minute job). A listener that
  // takes work before the next poll may overshoot the budget briefly; cgroup
  // weights share contended CPU, and the next poll recomputes.
  const sharing = Math.max(1, Math.min(active.length + start.length, busy + queued));
  Object.assign(state, { sharing, sharingAt: now });
  const { quota } = cpuPolicy(c, sharing, host, state);
  return { queued, waiting, active: active.length, busy, desired, pressure: !!state.pressure, quota,
    start: start.map(r => r.name), retiring: Math.max(0, active.length - desired) };
}

export function effectiveQuota(status, savedQuota) {
  const match = /^Live CPU quota: (max|[0-9]+) ([0-9]+)$/m.exec(status);
  if (!match || match[1] === 'max' || Number(match[2]) < 1) return NaN;
  const quota = Number(match[1]) / Number(match[2]) * 100;
  // A stale saved quota also needs repair, even if the live cap happens to match policy.
  return Math.abs(quota - savedQuota) < 0.001 ? savedQuota : NaN;
}

// Controller health for `runnerctl health`: whether GitHub calls succeed, which
// token source is in use, and whether queued jobs see any online runner. The
// file is rewritten only when this changes, or once a minute as a heartbeat.
export const HEALTH_FILE = '.autoscale-health.json';
export const HEALTH_WRITE_INTERVAL_MS = 60000;
/**
 * poll: { at, tokenSource?: 'env'|'file'|'gh'|null, outcome: 'ok'|'failed'|'local',
 *   failure?: { kind, status? }, githubOk?: boolean, observed?: { queued, online, busy } }
 * 'local' means the poll stopped before GitHub was consulted; GitHub state is unchanged.
 */
export function trackHealth(previous, poll, c, pid = process.pid) {
  const prev = previous?.version === 1 && previous.scope === c.scope && previous.target === c.target ? previous : {};
  const next = { version: 1, pid, updatedAt: poll.at, intervalSeconds: c.intervalSeconds, scope: c.scope, target: c.target,
    tokenSource: poll.tokenSource !== undefined ? poll.tokenSource : prev.tokenSource ?? null,
    lastSuccessAt: poll.githubOk ? poll.at : prev.lastSuccessAt ?? null,
    error: prev.error ?? null, observed: prev.observed ?? null, queuedNoRunnersSince: prev.queuedNoRunnersSince ?? null };
  if (poll.observed) {
    const { queued, online, busy } = poll.observed;
    next.observed = { at: poll.at, queued, online, busy };
    next.queuedNoRunnersSince = queued > 0 && online === 0 ? prev.queuedNoRunnersSince ?? poll.at : null;
  }
  // A poll that read GitHub and then failed locally still proves the token works.
  if (poll.outcome === 'ok' || (poll.outcome === 'local' && poll.githubOk)) next.error = null;
  else if (poll.outcome === 'failed' && poll.failure) {
    const e = prev.error;
    const status = poll.failure.status ?? null;
    const same = e && e.kind === poll.failure.kind && (e.status ?? null) === status;
    next.error = { kind: poll.failure.kind, ...(status ? { status } : {}), since: same ? e.since : poll.at, lastAt: poll.at };
  }
  return next;
}
/** What must reach disk promptly; everything else waits for the heartbeat. */
export function healthFingerprint(h) {
  return JSON.stringify([h.scope, h.target, h.intervalSeconds, h.tokenSource, h.lastSuccessAt === null,
    h.error && [h.error.kind, h.error.status ?? null, h.error.since], h.queuedNoRunnersSince]);
}
export function healthWriteDue(written, next, now) {
  return !written || healthFingerprint(written.state) !== healthFingerprint(next) || now - written.at >= HEALTH_WRITE_INTERVAL_MS;
}
