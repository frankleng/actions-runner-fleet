import test from 'node:test';
import assert from 'node:assert/strict';
import { findProblems, planAlert, githubRunnerPath } from '../lib/runnerctl-health.mjs';

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
  assert.deepEqual(r.state, { firstSeen: {}, alerted: [] }); // Recovery resets.
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
