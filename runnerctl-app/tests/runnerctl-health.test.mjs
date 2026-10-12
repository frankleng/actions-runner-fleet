import test from 'node:test';
import assert from 'node:assert/strict';
import { findProblems, planAlert, groupByOrg, githubRunnerPath, renderAlertMarkdown } from '../lib/runnerctl-health.mjs';

const MIN = 60000;
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
    'slot-reserved:reserved', 'runner-offline:offline', 'runner-unregistered:gone', 'autoscaler-down:runnerctl-autoscale']);
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
