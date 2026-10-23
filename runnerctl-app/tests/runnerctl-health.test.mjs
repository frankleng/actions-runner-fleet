import test from 'node:test';
import assert from 'node:assert/strict';
import { findProblems as findAll, planAlert, groupByOrg, githubRunnerPath, renderAlertMarkdown, realProblems, DEFAULT_AUTOSCALE_THRESHOLD_MS } from '../lib/runnerctl-health.mjs';

const MIN = 60000;
// What is wrong now; planAlert itself always receives the holds too (see the carry-forward tests).
const findProblems = (...args) => realProblems(findAll(...args));
const healthy = { name: 'ci-1', kind: 'ephemeral', org: 'example-org', unitActive: true, unitUnrendered: false, phase: 'ready' };

test('a healthy fleet has no problems', () => {
  assert.deepEqual(findProblems([healthy, { name: 'p-1', kind: 'persistent', org: 'example-org', unitActive: true, github: 'online' }],
    { configured: true, active: true }), []);
});

test('detects every capacity-removing failure', () => {
  const problems = findProblems([
    { ...healthy, name: 'unrendered', unitActive: false, unitUnrendered: true },
    { ...healthy, name: 'blocked', phase: 'blocked' },
    { ...healthy, name: 'reserved', reservedSince: 0 },
    { name: 'offline', kind: 'persistent', org: 'example-org', unitActive: true, github: 'offline' },
    { name: 'gone', kind: 'persistent', org: 'example-org', unitActive: true, github: 'missing' },
    { name: 'unknown', kind: 'persistent', org: 'example-org', unitActive: true, github: 'unknown' },
  ], { configured: true, active: false });
  assert.deepEqual(problems.map(p => p.key), ['unrendered-unit:unrendered', 'service-down:unrendered', 'slot-blocked:blocked',
    'slot-reserved:reserved', 'runner-offline:offline', 'runner-unregistered:gone', 'runner-unverified:unknown', 'autoscaler-down:runnerctl-autoscale']);
  // An unconfigured autoscaler is not a problem.
  assert.equal(findProblems([], { configured: false, active: false }).length, 0);
});

test('alerts only after the threshold, once per incident, and again for new problems', () => {
  const a = findProblems([{ ...healthy, name: 'a', phase: 'blocked' }], { configured: false });
  let r = planAlert({}, a, 0, 30 * MIN);
  assert.equal(r.alert, null); // Transient problems never alert.
  r = planAlert(r.state, a, 29 * MIN, 30 * MIN);
  assert.equal(r.alert, null);
  r = planAlert(r.state, a, 30 * MIN, 30 * MIN);
  assert.match(r.alert.summary, /^1 runner problem\(s\) lasting 30\+ min: 1 slot-blocked$/);
  assert.equal(r.alert.problems[0].firstSeen, new Date(0).toISOString());
  r = planAlert(r.state, a, 90 * MIN, 30 * MIN);
  assert.equal(r.alert, null); // Ongoing incident: no repeat.
  const ab = findProblems([{ ...healthy, name: 'a', phase: 'blocked' }, { ...healthy, name: 'b', unitActive: false }], { configured: false });
  r = planAlert(r.state, ab, 100 * MIN, 30 * MIN);
  assert.equal(r.alert, null); // New problem is not overdue yet.
  r = planAlert(r.state, ab, 130 * MIN, 30 * MIN);
  assert.deepEqual(r.alert.problems.map(p => [p.runner, p.new]), [['a', false], ['b', true]]);
  r = planAlert(r.state, [], 140 * MIN, 30 * MIN);
  assert.deepEqual(r.state, { firstSeen: {}, alerted: [] }); // Recovery resets...
  assert.equal(r.resolved, true); // ...and closes the incident once.
  assert.equal(planAlert(r.state, [], 145 * MIN, 30 * MIN).resolved, undefined);
  r = planAlert(r.state, a, 140 * MIN, 30 * MIN);
  assert.equal(r.alert, null); // A recurrence starts a fresh clock.
});

test('runner API paths support organization and repository scopes only', () => {
  assert.equal(githubRunnerPath('https://github.com/example-org', 7), '/orgs/example-org/actions/runners/7');
  assert.equal(githubRunnerPath('https://github.com/owner/repo/', 7), '/repos/owner/repo/actions/runners/7');
  for (const [url, id] of [['https://github.com/enterprises/e/x/y', 7], ['https://evil.invalid/org', 7], ['https://github.com/org', 0], [undefined, 7]]) {
    assert.equal(githubRunnerPath(url, id), null);
  }
});

test('alert markdown escapes table cells and suggests checks only for overdue problems', () => {
  const md = renderAlertMarkdown({ host: 'h', kit: '/kit', summary: 'S', problems: [
    { kind: 'slot-reserved', runner: 'ci-1', org: 'o', detail: 'a|b', firstSeen: 'T', overdue: true, new: true },
    { kind: 'service-down', runner: 'ci-2', org: 'o', detail: 'd', firstSeen: 'T', overdue: false, new: false },
  ] });
  assert.ok(md.includes('a\\|b'));
  assert.ok(md.includes('🆕 `slot-reserved`'));
  assert.ok(md.includes('.runners/ci-1/.autoscale-reservation.json'));
  assert.ok(!md.includes("status 'actions.runner.*ci-2.service'"));
});

test('problems group by org, including the autoscaler, so each org is its own incident', () => {
  const problems = findProblems([
    { ...healthy, name: 't-1', org: 'titledock', unitActive: false },
    { name: 'f-1', kind: 'persistent', org: 'founderationhq', unitActive: true, github: 'offline' },
    { ...healthy, name: 'x-1', org: null, phase: 'blocked' },
  ], { configured: true, active: false, org: 'titledock' });
  const groups = groupByOrg(problems);
  assert.deepEqual(Object.keys(groups).sort(), ['founderationhq', 'titledock', 'unknown']);
  assert.deepEqual(groups.titledock.map(p => p.kind), ['service-down', 'autoscaler-down']);
  // One org recovering resolves only that org.
  let t = planAlert({}, groups.titledock, 0, 0);
  let f = planAlert({}, groups.founderationhq, 0, 0);
  assert.ok(t.alert && f.alert);
  t = planAlert(t.state, [], MIN, 0);
  f = planAlert(f.state, groups.founderationhq, MIN, 0);
  assert.equal(t.resolved, true);
  assert.equal(f.resolved, undefined);
  assert.equal(f.alert, null);
});

// The controller's .autoscale-health.json as it looks while GitHub answers normally.
const NOW = Date.parse('2026-10-23T22:00:00Z');
const report = (extra = {}) => ({ version: 1, pid: 1, updatedAt: NOW - 30000, intervalSeconds: 60, scope: 'organization', target: 'titledock',
  tokenSource: 'file', lastSuccessAt: NOW - 30000, error: null, observed: { at: NOW - 30000, queued: 0, online: 2, busy: 0 },
  queuedNoRunnersSince: null, ...extra });
const controller = health => ({ configured: true, active: true, org: 'titledock', health });
const autoscaleProblems = (health, now = NOW) => findProblems([], controller(health), { now }).map(p => p.kind);

test('a controller whose GitHub calls succeed with a dedicated token has no problems', () => {
  assert.deepEqual(autoscaleProblems(report()), []);
  // A stopped controller is only autoscaler-down; its last report is not evidence.
  assert.deepEqual(findProblems([], { configured: true, active: false, org: 'titledock', health: null }, { now: NOW }).map(p => p.kind), ['autoscaler-down']);
});

test('persistent autoscaler GitHub auth failures alert after the short threshold with the fix, never a token', () => {
  const since = NOW - 3 * MIN;
  const failure = { kind: 'auth', status: 403, since, lastAt: NOW - 30000 };
  const health = report({ tokenSource: 'gh', lastSuccessAt: NOW - 3 * MIN, error: failure, authFailure: failure });
  const problems = findProblems([], controller(health), { now: NOW });
  const auth = problems.find(p => p.kind === 'autoscaler-auth');
  assert.equal(auth.org, 'titledock');
  assert.match(auth.detail, /HTTP 403/);
  assert.match(auth.detail, /admin:org/);
  assert.match(auth.detail, /\.autoscale-token/);
  assert.match(auth.detail, /gh auth login/);
  // The clock starts when the controller first failed, not when health first looked.
  let r = planAlert({}, problems, NOW);
  assert.equal(r.alert, null);
  r = planAlert(r.state, problems, since + DEFAULT_AUTOSCALE_THRESHOLD_MS);
  assert.ok(r.alert.problems.some(p => p.kind === 'autoscaler-auth' && p.new));
  assert.match(r.alert.summary, /lasting 10\+ min/);
  assert.ok(!JSON.stringify(r.alert).includes('startedAt'));
  r = planAlert(r.state, problems, since + 20 * MIN);
  assert.equal(r.alert, null); // Once per incident.
  // A missing token and a refused token file are the same alert.
  for (const kind of ['no-token', 'token-file']) {
    assert.deepEqual(autoscaleProblems(report({ error: { kind, since, lastAt: NOW }, authFailure: { kind, since, lastAt: NOW } })), ['autoscaler-auth']);
  }
  // Rate limits and network errors are not authentication failures.
  for (const kind of ['rate-limit', 'network', 'http']) assert.deepEqual(autoscaleProblems(report({ error: { kind, status: 403, since, lastAt: NOW } })), []);
  // Recovery closes the incident.
  r = planAlert(planAlert({}, problems.filter(p => p.kind === 'autoscaler-auth'), NOW + DEFAULT_AUTOSCALE_THRESHOLD_MS).state,
    findProblems([], controller(report()), { now: NOW }), NOW + 30 * MIN);
  assert.equal(r.resolved, true);
});

test('jobs queued with none of the autoscaler runners online alert after the short threshold', () => {
  const since = NOW - 11 * MIN;
  const starved = report({ observed: { at: NOW - 30000, queued: 24, online: 0, busy: 0 }, queuedNoRunnersSince: since });
  const problems = findProblems([], controller(starved), { now: NOW });
  assert.deepEqual(problems.map(p => p.kind), ['autoscaler-starved']);
  assert.match(problems[0].detail, /24 job\(s\) queued for titledock/);
  assert.ok(planAlert({}, problems, NOW).alert);
  // An observation from a controller that stopped reporting proves nothing about now.
  const old = { ...starved, observed: { ...starved.observed, at: NOW - 20 * MIN } };
  assert.deepEqual(autoscaleProblems(old), []);
});

test('a running controller that stops reporting, or never reported, is stale', () => {
  assert.deepEqual(autoscaleProblems(report({ updatedAt: NOW - 2 * MIN })), []);
  const hung = findProblems([], controller(report({ updatedAt: NOW - 12 * MIN, authFailure: { kind: 'auth', status: 403, since: NOW - 20 * MIN } })), { now: NOW });
  // Stale hides the outdated details it would otherwise report.
  assert.deepEqual(hung.map(p => p.kind), ['autoscaler-stale']);
  assert.ok(planAlert({}, hung, NOW).alert); // Silent since 12 minutes: overdue at once.
  // A slow poll interval stretches the heartbeat it is judged by.
  assert.deepEqual(autoscaleProblems(report({ updatedAt: NOW - 12 * MIN, intervalSeconds: 300 })), []);
  for (const missing of [null, { version: 2 }]) {
    const problems = findProblems([], controller(missing), { now: NOW });
    assert.deepEqual(problems.map(p => p.kind), ['autoscaler-stale']);
    assert.equal(planAlert({}, problems, NOW).alert, null);
  }
});

test('an autoscaler on a personal gh login is a warning on the longer threshold', () => {
  const problems = findProblems([], controller(report({ tokenSource: 'gh' })), { now: NOW, thresholdMs: 30 * MIN });
  assert.deepEqual(problems.map(p => [p.kind, p.severity]), [['autoscaler-personal-token', 'warning']]);
  let r = planAlert({}, problems, NOW, 30 * MIN);
  r = planAlert(r.state, problems, NOW + 15 * MIN, 30 * MIN);
  assert.equal(r.alert, null);
  r = planAlert(r.state, problems, NOW + 30 * MIN, 30 * MIN);
  assert.equal(r.alert.problems[0].severity, 'warning');
  assert.ok(renderAlertMarkdown({ host: 'h', kit: '/kit', ...r.alert }).includes('.autoscale-token'));
  for (const tokenSource of ['env', 'file']) assert.deepEqual(autoscaleProblems(report({ tokenSource })), []);
});

test('a rate-limit pause after an auth failure keeps the auth outage and its clock', () => {
  // The latest error is the pause; the outage clock still runs from the first 403.
  const health = report({ error: { kind: 'rate-limit', since: NOW - MIN, lastAt: NOW - 30000 },
    authFailure: { kind: 'auth', status: 403, since: NOW - 11 * MIN, lastAt: NOW - 2 * MIN } });
  const problems = findProblems([], controller(health), { now: NOW });
  assert.deepEqual(problems.map(p => p.kind), ['autoscaler-auth']);
  assert.ok(planAlert({}, problems, NOW).alert);
});

test('an auth outage that recovered and recurred between checks is a new problem with a new clock', () => {
  const outage = since => findProblems([], controller(report({ authFailure: { kind: 'auth', status: 403, since, lastAt: NOW } })), { now: NOW });
  let r = planAlert({}, outage(NOW - 11 * MIN), NOW);
  assert.ok(r.alert); // First outage alerts.
  // Between checks it recovered and failed again a minute ago.
  // The first outage's incident resolves; the new one is not overdue yet.
  r = planAlert(r.state, outage(NOW + 4 * MIN), NOW + 5 * MIN);
  assert.deepEqual([r.alert, r.resolved], [null, true]);
  r = planAlert(r.state, outage(NOW + 4 * MIN), NOW + 13 * MIN);
  assert.equal(r.alert, null);
  // It alerts again once the new outage is itself overdue.
  r = planAlert(r.state, outage(NOW + 4 * MIN), NOW + 14 * MIN);
  assert.ok(r.alert.problems.find(p => p.kind === 'autoscaler-auth').new);
});

test('recovery is reported even while other problems or warnings remain on the same org', () => {
  const auth = findProblems([], controller(report({ tokenSource: 'gh', authFailure: { kind: 'auth', status: 403, since: NOW - 11 * MIN, lastAt: NOW } })),
    { now: NOW, thresholdMs: 30 * MIN });
  let r = planAlert({}, auth, NOW, 30 * MIN);
  assert.ok(r.alert.problems.some(p => p.kind === 'autoscaler-auth' && p.new));
  // Auth recovers; the personal-token warning has not aged into an alert: the incident resolves.
  const warningOnly = findProblems([], controller(report({ tokenSource: 'gh' })), { now: NOW, thresholdMs: 30 * MIN });
  const recovered = planAlert(r.state, warningOnly, NOW + 5 * MIN, 30 * MIN);
  assert.equal(recovered.resolved, true);
  // The warning still alerts later on its own.
  assert.ok(planAlert(recovered.state, warningOnly, NOW + 31 * MIN, 30 * MIN).alert);
  // Auth recovers while an alerted warning stays open: the recovery is still reported.
  r = planAlert(r.state, auth, NOW + 30 * MIN, 30 * MIN);
  assert.ok(r.alert.problems.some(p => p.kind === 'autoscaler-personal-token' && p.new));
  r = planAlert(r.state, warningOnly, NOW + 35 * MIN, 30 * MIN);
  assert.match(r.alert.summary, /^1 runner problem\(s\) still open; recovered: 1 autoscaler-auth$/);
  assert.deepEqual(r.alert.recovered, ['autoscaler-auth']);
  assert.equal(planAlert(r.state, warningOnly, NOW + 40 * MIN, 30 * MIN).alert, null); // Reported once.
});

test('an alerted auth outage stays open while the controller hangs, and resolves only on a clean poll', () => {
  const outage = report({ authFailure: { kind: 'auth', status: 403, since: NOW - 11 * MIN, lastAt: NOW } });
  let r = planAlert({}, findAll([], controller(outage), { now: NOW }), NOW);
  assert.ok(r.alert);
  // Five minutes later the controller is hung: its report proves neither failure nor recovery.
  const hung = findAll([], controller({ ...outage, updatedAt: NOW }), { now: NOW + 5 * MIN });
  r = planAlert(r.state, hung, NOW + 5 * MIN);
  assert.equal(r.resolved, undefined);
  assert.equal(r.alert, null);
  assert.ok(r.state.alerted.some(k => k.startsWith('autoscaler-auth:')));
  // Stopped controller: the same.
  r = planAlert(r.state, findAll([], { configured: true, active: false, org: 'titledock', health: outage }, { now: NOW + 6 * MIN }), NOW + 6 * MIN);
  assert.equal(r.resolved, undefined);
  assert.ok(r.state.alerted.some(k => k.startsWith('autoscaler-auth:')));
  // A fresh report with a clean authenticated poll is the evidence.
  const clean = report({ updatedAt: NOW + 7 * MIN - 30000, lastSuccessAt: NOW + 7 * MIN - 30000,
    observed: { at: NOW + 7 * MIN - 30000, queued: 0, online: 2, busy: 0 } });
  r = planAlert(r.state, findAll([], controller(clean), { now: NOW + 7 * MIN }), NOW + 7 * MIN);
  assert.equal(r.resolved, true);
});

test('alerted starvation stays open through GitHub errors and resolves only once runners are seen', () => {
  const starved = report({ observed: { at: NOW - 30000, queued: 24, online: 0, busy: 0 }, queuedNoRunnersSince: NOW - 11 * MIN });
  let r = planAlert({}, findAll([], controller(starved), { now: NOW }), NOW);
  assert.ok(r.alert);
  // Five minutes of HTTP 503: the controller keeps reporting, but observes nothing.
  const blind = { ...starved, updatedAt: NOW + 5 * MIN - 30000, error: { kind: 'http', status: 503, since: NOW, lastAt: NOW + 5 * MIN - 30000 } };
  r = planAlert(r.state, findAll([], controller(blind), { now: NOW + 5 * MIN }), NOW + 5 * MIN);
  assert.equal(r.resolved, undefined);
  assert.ok(r.state.alerted.some(k => k.startsWith('autoscaler-starved:')));
  // Holds never raise anything on their own.
  assert.deepEqual(planAlert({}, findAll([], controller(blind), { now: NOW + 5 * MIN }), NOW + 5 * MIN).state, { firstSeen: {}, alerted: [] });
  const served = report({ updatedAt: NOW + 6 * MIN, observed: { at: NOW + 6 * MIN, queued: 3, online: 2, busy: 2 } });
  r = planAlert(r.state, findAll([], controller(served), { now: NOW + 6 * MIN }), NOW + 6 * MIN);
  assert.equal(r.resolved, true);
});
