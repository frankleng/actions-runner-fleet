// Fleet health: turn per-runner facts into problems, and decide when a problem
// has lasted long enough to alert. Everything here is pure so it can be tested
// without systemd, GitHub, or a webhook.

export const DEFAULT_THRESHOLD_MS = 30 * 60 * 1000;
// Autoscaler outages stop every job for the org, so they alert sooner.
export const DEFAULT_AUTOSCALE_THRESHOLD_MS = 10 * 60 * 1000;
const HEALTH_HEARTBEAT_MS = 60 * 1000;
const iso = ms => new Date(ms).toISOString();
const TOKEN_FIX = 'see README "Autoscaler GitHub token"; prefer a dedicated token in .autoscale-token (mode 0600)';

/**
 * Problems from the controller's own report (.autoscale-health.json, or null
 * when it has none). Only meaningful while the controller service is active;
 * a stopped controller is already autoscaler-down.
 */
export function autoscalerHealthProblems(health, { now, thresholdMs = DEFAULT_AUTOSCALE_THRESHOLD_MS, warningThresholdMs = DEFAULT_THRESHOLD_MS } = {}) {
  const problems = [];
  const add = (kind, detail, extra = {}) => problems.push({ kind, detail, thresholdMs, ...extra });
  if (!health || health.version !== 1 || !Number.isFinite(health.updatedAt)) {
    add('autoscaler-stale', 'autoscale controller is running but has written no .autoscale-health.json; restart it if it predates health reporting');
    return problems;
  }
  // Heartbeats come once a minute or once a poll, whichever is longer.
  const heartbeat = Math.max(HEALTH_HEARTBEAT_MS, (health.intervalSeconds ?? 60) * 1000);
  const staleAfter = 3 * heartbeat;
  if (now - health.updatedAt > staleAfter) {
    add('autoscaler-stale', `autoscale controller is running but has not completed a poll since ${iso(health.updatedAt)}; it may be hung`,
      { startedAt: health.updatedAt, thresholdMs: Math.max(thresholdMs, staleAfter) });
    // Its last report is no longer evidence of the present.
    return problems;
  }
  const viaGh = health.tokenSource === 'gh' ? ' It is using the gh login (gh auth token); re-running gh auth login without -s admin:org drops the scope.' : '';
  const e = health.error;
  if (e && Number.isFinite(e.since)) {
    if (e.kind === 'auth') {
      add('autoscaler-auth', `autoscaler GitHub calls rejected (HTTP ${e.status ?? '401/403'}) since ${iso(e.since)}: the token likely lacks admin:org ` +
        `(classic) or organization Self-hosted runners: read and write (fine-grained); ${TOKEN_FIX}.${viaGh}`, { startedAt: e.since });
    } else if (e.kind === 'no-token') {
      add('autoscaler-auth', `autoscaler has no GitHub token since ${iso(e.since)} (RUNNER_AUTOSCALE_TOKEN, .autoscale-token, or gh auth token); ${TOKEN_FIX}`, { startedAt: e.since });
    } else if (e.kind === 'token-file') {
      add('autoscaler-auth', `autoscaler refuses its token file since ${iso(e.since)}: it must be a regular file owned by the controller user with mode 0600; ${TOKEN_FIX}`, { startedAt: e.since });
    }
  }
  const seen = health.observed;
  if (Number.isFinite(health.queuedNoRunnersSince) && seen && now - seen.at <= staleAfter) {
    add('autoscaler-starved', `${seen.queued} job(s) queued for ${health.target} with none of the autoscaler's runners online since ${iso(health.queuedNoRunnersSince)}`,
      { startedAt: health.queuedNoRunnersSince });
  }
  if (health.tokenSource === 'gh') {
    add('autoscaler-personal-token', `autoscaler uses a personal gh login (gh auth token); any gh auth login can change its scopes and stop autoscaling; ${TOKEN_FIX}`,
      { thresholdMs: warningThresholdMs, severity: 'warning' });
  }
  return problems;
}

/**
 * facts: [{ name, kind: 'persistent'|'ephemeral', org, unitActive, unitUnrendered,
 *   phase, reservedSince, github: 'online'|'offline'|'missing'|'unknown' }]
 * autoscaler: { configured, active, org, health? } — health is the controller's
 *   parsed report, or null when missing; omit it to skip those checks.
 * options: { now, autoscaleThresholdMs, thresholdMs } for the controller report.
 */
export function findProblems(facts, autoscaler, options = {}) {
  const problems = [];
  const add = (kind, runner, org, detail, since, extra = {}) => problems.push({ key: `${kind}:${runner}`, kind, runner, org, detail, ...(since != null ? { since } : {}), ...extra });
  for (const f of facts) {
    if (f.unitUnrendered) add('unrendered-unit', f.name, f.org, 'service unit contains unfilled {{...}} placeholders; it fails at boot with status=217/USER');
    if (!f.unitActive) add('service-down', f.name, f.org, 'runner service is not active');
    if (f.kind === 'ephemeral') {
      if (f.phase === 'blocked') add('slot-blocked', f.name, f.org, 'autoscale slot is parked as blocked and will not receive work');
      if (f.reservedSince != null) add('slot-reserved', f.name, f.org, 'ambiguous registration reservation has not been resolved', new Date(f.reservedSince).toISOString());
    } else if (f.github === 'offline') {
      add('runner-offline', f.name, f.org, 'persistent runner is offline at GitHub');
    } else if (f.github === 'missing') {
      add('runner-unregistered', f.name, f.org, 'persistent runner has no GitHub registration');
    } else if (f.github !== 'online') {
      // A failed check is not a healthy runner: expired tokens and a locked keyring look like this.
      add('runner-unverified', f.name, f.org, 'could not confirm the runner is online at GitHub (token or API failure)');
    }
  }
  if (autoscaler.configured && !autoscaler.active) add('autoscaler-down', 'runnerctl-autoscale', autoscaler.org ?? null, 'autoscale controller service is not active');
  if (autoscaler.configured && autoscaler.active && autoscaler.health !== undefined) {
    const now = options.now ?? Date.now();
    for (const { kind, detail, ...extra } of autoscalerHealthProblems(autoscaler.health, { now,
      thresholdMs: options.autoscaleThresholdMs, warningThresholdMs: options.thresholdMs })) {
      add(kind, 'runnerctl-autoscale', autoscaler.org ?? null, detail, extra.startedAt != null ? iso(extra.startedAt) : null, extra);
    }
  }
  return problems;
}

/**
 * Track how long each problem has persisted. Alert once per set of overdue
 * problems: a new overdue problem re-alerts, an ongoing one does not, and a
 * fully healthy fleet resets everything. A problem may carry its own
 * thresholdMs, and a startedAt (epoch ms) when its source knows how long it has
 * lasted already.
 */
export function planAlert(previous, problems, now, thresholdMs = DEFAULT_THRESHOLD_MS) {
  const firstSeen = {};
  for (const p of problems) firstSeen[p.key] = previous?.firstSeen?.[p.key] ?? Math.min(now, p.startedAt ?? now);
  const current = new Set(problems.map(p => p.key));
  const alerted = new Set((previous?.alerted ?? []).filter(k => current.has(k)));
  const limit = p => p.thresholdMs ?? thresholdMs;
  const isOverdue = p => now - firstSeen[p.key] >= limit(p);
  const overdue = problems.filter(isOverdue);
  const fresh = overdue.filter(p => !alerted.has(p.key));
  for (const p of overdue) alerted.add(p.key);
  const state = { firstSeen, alerted: [...alerted].sort() };
  // Everything that was alerted on is healthy again: close the incident.
  if (!problems.length && previous?.alerted?.length) return { state, alert: null, resolved: true };
  if (!fresh.length) return { state, alert: null };
  const counts = {};
  for (const p of overdue) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
  const minutes = Math.round(Math.min(...overdue.map(limit)) / 60000);
  const summary = `${overdue.length} runner problem(s) lasting ${minutes}+ min: ` +
    Object.entries(counts).map(([kind, n]) => `${n} ${kind}`).join(', ');
  return {
    state,
    alert: {
      summary,
      problems: problems.map(p => {
        const { key, startedAt, thresholdMs: _, ...rest } = p;
        return { ...rest, firstSeen: new Date(firstSeen[key]).toISOString(), overdue: isOverdue(p), new: fresh.some(f => f.key === key) };
      }),
    },
  };
}

/** Problems grouped by GitHub org; each org is a separate incident. */
export const UNKNOWN_ORG = 'unknown';
export function groupByOrg(problems) {
  const groups = {};
  for (const p of problems) (groups[p.org ?? UNKNOWN_ORG] ??= []).push(p);
  return groups;
}

/** GitHub REST path for a runner registered at a repository or organization URL. */
export function githubRunnerPath(gitHubUrl, id) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\/([A-Za-z0-9][A-Za-z0-9_.-]*))?\/?$/.exec(gitHubUrl ?? '');
  if (!match) return null;
  return match[2] ? `/repos/${match[1]}/${match[2]}/actions/runners/${id}` : `/orgs/${match[1]}/actions/runners/${id}`;
}

// What to look at first for each problem kind. Commands are read-only.
const CHECKS = {
  'unrendered-unit': runner => [`grep -n '{{' ~/.config/systemd/user/actions.runner.*${runner}.service`, `./manage-runners.sh reconcile ${runner}   # re-renders from the kit template (changes files)`],
  'service-down': runner => [`systemctl --user status 'actions.runner.*${runner}.service'`, `journalctl --user -u 'actions.runner.*${runner}.service' -n 80 --no-pager`],
  'slot-blocked': runner => [`cat .runners/${runner}/.autoscale-state.json`, `ls -la .runners/${runner}/   # never print .credentials*, .runner or .autoscale-request/inflight`],
  'slot-reserved': runner => [`ls -la --time-style=full-iso .runners/${runner}/.autoscale-reservation.json`, `journalctl --user -u 'runnerctl-autoscale-*' -n 100 --no-pager`],
  'runner-offline': runner => [`systemctl --user status 'actions.runner.*${runner}.service'`, `journalctl --user -u 'actions.runner.*${runner}.service' -n 80 --no-pager`],
  'runner-unverified': () => [`gh auth status   # a locked keyring or expired token hides runner status`, `./runnerctl health --dry-run`],
  'runner-unregistered': runner => [`ls -la .runners/${runner}/`, `# re-register with ./bootstrap.sh --replace-existing ${runner}`],
  'autoscaler-down': () => [`systemctl --user status 'runnerctl-autoscale-*'`, `journalctl --user -u 'runnerctl-autoscale-*' -n 100 --no-pager`],
  'autoscaler-auth': () => [`cat .autoscale-health.json   # error kind, HTTP status and token source; never the token`,
    `gh auth status   # when the token source is gh: its scopes must include admin:org`,
    `# fix: put a dedicated token in .autoscale-token (mode 0600); the next poll picks it up (README: Autoscaler GitHub token)`],
  'autoscaler-starved': () => [`cat .autoscale-health.json`, `journalctl --user -u 'runnerctl-autoscale-*' -n 100 --no-pager`, `./runnerctl autoscale --dry-run`],
  'autoscaler-stale': () => [`ls -la --time-style=full-iso .autoscale-health.json`, `systemctl --user status 'runnerctl-autoscale-*'`,
    `journalctl --user -u 'runnerctl-autoscale-*' -n 100 --no-pager`],
  'autoscaler-personal-token': () => [`cat .autoscale-health.json   # tokenSource: gh`,
    `# create a dedicated token (README: Autoscaler GitHub token), save it to .autoscale-token with mode 0600`],
};
const cell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

/** Markdown for an alert, suitable for an issue body. */
export function renderAlertMarkdown({ host, kit, summary, problems }) {
  const rows = problems.map(p => `| ${p.new ? '🆕 ' : ''}\`${cell(p.kind)}\`${p.severity === 'warning' ? ' (warning)' : ''} | \`${cell(p.runner)}\` | ${cell(p.org ?? '')} | ${cell(p.firstSeen)} | ${cell(p.detail)} |`);
  const checks = [];
  const seen = new Set();
  for (const p of problems.filter(p => p.overdue)) {
    const key = `${p.kind}:${p.runner}`;
    if (seen.has(key) || !CHECKS[p.kind]) continue;
    seen.add(key);
    checks.push(`**${p.kind}** on \`${p.runner}\`:`, '```bash', ...CHECKS[p.kind](p.runner), '```');
  }
  return [`**${summary}**`, '', `Host \`${host}\`, kit \`${kit}\`.`, '',
    '| Problem | Runner | Org | First seen (UTC) | Detail |', '|---|---|---|---|---|', ...rows, '',
    '### Where to look', `Run from \`${kit}\`:`, '', ...checks].join('\n');
}
