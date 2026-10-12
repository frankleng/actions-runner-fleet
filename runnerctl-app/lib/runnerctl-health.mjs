// Fleet health: turn per-runner facts into problems, and decide when a problem
// has lasted long enough to alert. Everything here is pure so it can be tested
// without systemd, GitHub, or a webhook.

export const DEFAULT_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * facts: [{ name, kind: 'persistent'|'ephemeral', org, unitActive, unitUnrendered,
 *   phase, reservedSince, github: 'online'|'offline'|'missing'|'unknown' }]
 * autoscaler: { configured, active, org }
 */
export function findProblems(facts, autoscaler) {
  const problems = [];
  const add = (kind, runner, org, detail, since) => problems.push({ key: `${kind}:${runner}`, kind, runner, org, detail, ...(since != null ? { since } : {}) });
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
  return problems;
}

/**
 * Track how long each problem has persisted. Alert once per set of overdue
 * problems: a new overdue problem re-alerts, an ongoing one does not, and a
 * fully healthy fleet resets everything.
 */
export function planAlert(previous, problems, now, thresholdMs = DEFAULT_THRESHOLD_MS) {
  const firstSeen = {};
  for (const p of problems) firstSeen[p.key] = previous?.firstSeen?.[p.key] ?? now;
  const current = new Set(problems.map(p => p.key));
  const alerted = new Set((previous?.alerted ?? []).filter(k => current.has(k)));
  const overdue = problems.filter(p => now - firstSeen[p.key] >= thresholdMs);
  const fresh = overdue.filter(p => !alerted.has(p.key));
  for (const p of overdue) alerted.add(p.key);
  const state = { firstSeen, alerted: [...alerted].sort() };
  // Everything that was alerted on is healthy again: close the incident.
  if (!problems.length && previous?.alerted?.length) return { state, alert: null, resolved: true };
  if (!fresh.length) return { state, alert: null };
  const counts = {};
  for (const p of overdue) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
  const minutes = Math.round(thresholdMs / 60000);
  const summary = `${overdue.length} runner problem(s) lasting ${minutes}+ min: ` +
    Object.entries(counts).map(([kind, n]) => `${n} ${kind}`).join(', ');
  return {
    state,
    alert: {
      summary,
      problems: problems.map(({ key, ...p }) => ({ ...p, firstSeen: new Date(firstSeen[key]).toISOString(),
        overdue: now - firstSeen[key] >= thresholdMs, new: fresh.some(f => f.key === key) })),
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
};
const cell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

/** Markdown for an alert, suitable for an issue body. */
export function renderAlertMarkdown({ host, kit, summary, problems }) {
  const rows = problems.map(p => `| ${p.new ? '🆕 ' : ''}\`${cell(p.kind)}\` | \`${cell(p.runner)}\` | ${cell(p.org ?? '')} | ${cell(p.firstSeen)} | ${cell(p.detail)} |`);
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
