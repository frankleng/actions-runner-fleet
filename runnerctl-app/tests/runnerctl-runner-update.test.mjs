import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { validateConfig } from '../lib/runnerctl-autoscale.mjs';
import { findProblems } from '../lib/runnerctl-health.mjs';
import { releaseCandidate, checkDue, checkForUpdate, rollSlot, diagnoseBlockedSlot, orphanDecision, pruneImages, compareVersions, runnerFilesVersion,
  readyTarget, buildImage, imageValid, clearRecoveredGeneration, finishRecovery, CHECK_INTERVAL_MS, FORCED_CHECK_INTERVAL_MS, UpdateRefusal } from '../lib/runnerctl-runner-update.mjs';

const exec = promisify(execFile);
const linux = { name: 'linux-x64', ext: 'tar.gz' };
const OLD = '2.336.0';
const NEW = '2.338.2';
const exists = file => fs.access(file).then(() => true, () => false);
const config = (extra = {}) => validateConfig({ scope: 'organization', target: 'example-org', labels: ['self-hosted'], runnerGroupId: 1,
  repositories: ['example-org/example-repo'], runners: ['runner-1', 'runner-2', 'runner-3'], minRunners: 1, maxRunners: 3, ...extra }, { cpus: 8, memoryBytes: 64 * 2 ** 30 });

async function tempDir(prefix) { return fs.mkdtemp(path.join(tmpdir(), prefix)); }
// Runner files as the release archive ships them, tagged with a version.
async function runnerFiles(directory, version, marker = version) {
  await fs.mkdir(path.join(directory, 'bin'), { recursive: true });
  await fs.mkdir(path.join(directory, 'externals/node24/bin'), { recursive: true });
  await fs.writeFile(path.join(directory, 'bin/Runner.Listener.deps.json'), JSON.stringify({ libraries: { [`Runner.Listener/${version}`]: {} } }));
  await fs.writeFile(path.join(directory, 'bin/Runner.Listener'), `listener ${marker}`);
  await fs.writeFile(path.join(directory, 'externals/node24/bin/node'), `node ${marker}`);
  for (const leaf of ['config.sh', 'run.sh', 'safe_sleep.sh', 'env.sh']) await fs.writeFile(path.join(directory, leaf), `${leaf} ${marker}`);
}
async function archive(version, marker = version, extra = async () => {}) {
  const dir = await tempDir('runner-release-');
  const content = path.join(dir, 'content');
  await runnerFiles(content, version, marker);
  await extra(content);
  const file = path.join(dir, `actions-runner-linux-x64-${version}.tar.gz`);
  await exec('tar', ['-czf', file, '-C', content, '.']);
  const bytes = await fs.readFile(file);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function release(version, notesSha, digestSha, extra = {}) {
  return { tag_name: `v${version}`, draft: false, prerelease: false,
    body: `notes\n<!-- BEGIN SHA linux-x64 -->${notesSha}<!-- END SHA linux-x64 -->\n<!-- BEGIN SHA osx-arm64 -->${'0'.repeat(64)}<!-- END SHA osx-arm64 -->`,
    assets: [{ name: `actions-runner-linux-x64-${version}.tar.gz`, digest: digestSha ? `sha256:${digestSha}` : null }], ...extra };
}
// A GitHub stand-in: the release API (with ETags) and the release download.
function mockGithub(releaseBody, bytes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, etag: options.headers?.['If-None-Match'] ?? null, auth: options.headers?.Authorization ?? null });
    if (url.startsWith('https://api.github.com/repos/actions/runner/releases/')) {
      if (options.headers?.['If-None-Match'] === '"v1"') return new Response(null, { status: 304 });
      return new Response(JSON.stringify(releaseBody), { status: 200, headers: { etag: '"v1"' } });
    }
    if (url.startsWith('https://github.com/actions/runner/releases/download/')) return new Response(bytes, { status: 200 });
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}

test('runnerUpdates config defaults to auto and accepts off or a pinned version', () => {
  assert.equal(config().runnerUpdates, 'auto');
  assert.equal(config().runnerVersion, null);
  assert.equal(config({ runnerUpdates: 'off' }).runnerUpdates, 'off');
  assert.equal(config({ runnerVersion: NEW }).runnerVersion, NEW);
  assert.throws(() => config({ runnerUpdates: 'sometimes' }));
  assert.throws(() => config({ runnerVersion: 'latest' }));
});

test('releases are checked every few hours, sooner after a deprecation report, never when off', () => {
  const c = config();
  const now = 10 * CHECK_INTERVAL_MS;
  assert.equal(checkDue({ version: 1 }, c, now), true);
  const checked = { version: 1, pin: null, checkedAt: now - 1000 };
  assert.equal(checkDue(checked, c, now), false);
  assert.equal(checkDue({ ...checked, checkedAt: now - CHECK_INTERVAL_MS }, c, now), true);
  assert.equal(checkDue(checked, c, now, { deprecationSeen: true }), 'forced');
  assert.equal(checkDue({ ...checked, forcedAt: now - FORCED_CHECK_INTERVAL_MS / 2 }, c, now, { deprecationSeen: true }), false);
  // Once a newer verified runner is ready, a deprecation report forces nothing.
  assert.equal(checkDue({ ...checked, target: { version: NEW }, deprecated: { version: OLD } }, c, now, { deprecationSeen: true }), false);
  assert.equal(checkDue({ version: 1 }, config({ runnerUpdates: 'off' }), now, { deprecationSeen: true }), false);
  // A new pin asks at once.
  assert.equal(checkDue(checked, config({ runnerVersion: NEW }), now), true);
});

test('a release is trusted only when the notes checksum and asset digest agree', () => {
  const sha = 'a'.repeat(64);
  const candidate = releaseCandidate(release(NEW, sha, sha), linux);
  assert.deepEqual(candidate, { version: NEW, sha256: sha, name: `actions-runner-linux-x64-${NEW}.tar.gz`,
    url: `https://github.com/actions/runner/releases/download/v${NEW}/actions-runner-linux-x64-${NEW}.tar.gz` });
  assert.equal(releaseCandidate(release(NEW, sha, sha, { prerelease: true }), linux), null);
  assert.equal(releaseCandidate(release(NEW, sha, sha, { draft: true }), linux), null);
  const refusal = reason => error => error instanceof UpdateRefusal && error.reason === reason;
  assert.throws(() => releaseCandidate(release(NEW, sha, 'b'.repeat(64)), linux), refusal('checksum-mismatch'));
  assert.throws(() => releaseCandidate(release(NEW, sha, null), linux), refusal('missing-asset-digest'));
  assert.throws(() => releaseCandidate({ ...release(NEW, sha, sha), body: 'no markers' }, linux), refusal('missing-notes-checksum'));
  assert.throws(() => releaseCandidate({ ...release(NEW, sha, sha), assets: [] }, linux), refusal('missing-asset'));
  // The download URL comes from the version, never from the response.
  const hostile = release(NEW, sha, sha);
  hostile.assets[0].browser_download_url = 'http://example.com/evil.tar.gz';
  assert.match(releaseCandidate(hostile, linux).url, /^https:\/\/github\.com\/actions\/runner\//);
});

test('discovery downloads, verifies and builds the image once; ETag revalidation costs no download', async () => {
  const root = await tempDir('runner-update-root-');
  const { bytes, sha256 } = await archive(NEW);
  const gh = mockGithub(release(NEW, sha256, sha256), bytes);
  const c = config();
  let state = await checkForUpdate({ version: 1 }, c, { root, token: 'private-test-value', now: 1000, fetchImpl: gh.fetchImpl, p: linux });
  assert.equal(state.target.version, NEW);
  assert.equal(state.target.sha256, sha256);
  assert.equal(state.refusal ?? null, null);
  assert.equal(await runnerFilesVersion(path.join(root, `actions-runner-linux-x64-${NEW}.image`)), NEW);
  assert.deepEqual(await readyTarget(state, root), { version: NEW, image: path.join(root, `actions-runner-linux-x64-${NEW}.image`) });
  // The token goes to the API only, never to the download host.
  assert.equal(gh.calls.find(call => call.url.includes('/releases/latest')).auth, 'Bearer private-test-value');
  assert.equal(gh.calls.find(call => call.url.includes('/download/')).auth, null);
  assert.ok(!JSON.stringify(state).includes('private-test-value'));
  const downloads = gh.calls.filter(call => call.url.includes('/download/')).length;
  state = await checkForUpdate(state, c, { root, token: 'private-test-value', now: 2000 + CHECK_INTERVAL_MS, fetchImpl: gh.fetchImpl, p: linux });
  assert.equal(gh.calls.at(-1).etag, '"v1"');
  assert.equal(gh.calls.filter(call => call.url.includes('/download/')).length, downloads);
  assert.equal(state.target.version, NEW);
  // An older latest (or pin) never moves the target backwards.
  const older = await archive(OLD);
  const back = mockGithub(release(OLD, older.sha256, older.sha256), older.bytes);
  state = await checkForUpdate({ ...state, etag: null }, c, { root, now: 3000, fetchImpl: back.fetchImpl, p: linux });
  assert.equal(state.target.version, NEW);
  assert.ok(!back.calls.some(call => call.url.includes('/download/')));
});

test('an archive whose SHA-256 differs from the release checksums is refused and never extracted', async () => {
  const root = await tempDir('runner-update-root-');
  const good = await archive(NEW);
  const tampered = await archive(NEW, 'tampered');
  const gh = mockGithub(release(NEW, good.sha256, good.sha256), tampered.bytes);
  const previous = { version: 1, target: { version: OLD, image: `actions-runner-linux-x64-${OLD}.image` } };
  const state = await checkForUpdate(previous, config(), { root, now: 1000, fetchImpl: gh.fetchImpl, p: linux });
  assert.deepEqual(state.target, previous.target);
  assert.equal(state.refusal.reason, 'archive-checksum-mismatch');
  assert.equal(state.refusal.version, NEW);
  assert.deepEqual((await fs.readdir(root)).filter(n => n.startsWith('actions-runner') || n.startsWith('.autoscale-runner-')), []);
  // Disagreeing checksums are refused before any download.
  const split = mockGithub(release(NEW, good.sha256, 'c'.repeat(64)), good.bytes);
  const refused = await checkForUpdate({ version: 1 }, config(), { root, now: 1000, fetchImpl: split.fetchImpl, p: linux });
  assert.equal(refused.refusal.reason, 'checksum-mismatch');
  assert.ok(!split.calls.some(call => call.url.includes('/download/')));
  // Health surfaces the refusal.
  const problems = findProblems([], { configured: true, active: true, org: 'example-org', runnerUpdate: state });
  assert.ok(problems.some(p => p.kind === 'runner-update-refused' && p.detail.includes('archive-checksum-mismatch')));
});

async function slot(root, name, version) {
  const directory = path.join(root, name);
  await runnerFiles(directory, version);
  await fs.writeFile(path.join(directory, 'env.sh'), 'kit env.sh');
  await fs.writeFile(path.join(directory, 'svc.sh'), 'kit svc.sh');
  await fs.writeFile(path.join(directory, 'runsvc.sh'), 'kit runsvc.sh');
  await fs.writeFile(path.join(directory, '.autoscale-slot.json'), JSON.stringify({ version: 1, agentName: name, gitHubUrl: 'https://github.com/example-org' }));
  await fs.writeFile(path.join(directory, '.autoscale-state.json'), JSON.stringify({ phase: 'ready' }));
  await fs.writeFile(path.join(directory, '.env'), 'LANG=C');
  await fs.writeFile(path.join(directory, '.path'), '/usr/bin');
  await fs.mkdir(path.join(directory, '_work/repo'), { recursive: true });
  await fs.writeFile(path.join(directory, '_work/repo/file'), 'workspace');
  await fs.mkdir(path.join(directory, '_diag'));
  return directory;
}
async function overlay(root) {
  const dir = path.join(root, 'overlay');
  await fs.mkdir(path.join(dir, 'bin'), { recursive: true });
  for (const leaf of ['runsvc.sh', 'autoscale-lock.mjs', 'autoscale-worker.mjs', 'bin/actions.runner.service.template']) await fs.writeFile(path.join(dir, leaf), `overlay ${leaf}`);
  return dir;
}

test('a slot rolls at a generation boundary, replacing only archive files and keeping slot state', async () => {
  const root = await tempDir('runner-roll-');
  const image = path.join(root, 'image');
  await runnerFiles(image, NEW);
  const overlayDir = await overlay(root);
  const directory = await slot(root, 'runner-1', OLD);
  // Never while a generation holds credentials or a handoff.
  await fs.writeFile(path.join(directory, '.runner'), '{}');
  await assert.rejects(rollSlot(directory, { image, version: NEW, overlayDir }), /between generations/);
  assert.equal(await runnerFilesVersion(directory), OLD);
  await fs.rm(path.join(directory, '.runner'));
  await fs.writeFile(path.join(directory, '.autoscale-inflight.json'), '{}');
  await assert.rejects(rollSlot(directory, { image, version: NEW, overlayDir }), /between generations/);
  await fs.rm(path.join(directory, '.autoscale-inflight.json'));

  assert.equal(await rollSlot(directory, { image, version: NEW, overlayDir }), NEW);
  assert.equal(await runnerFilesVersion(directory), NEW);
  assert.equal(await fs.readFile(path.join(directory, 'externals/node24/bin/node'), 'utf8'), `node ${NEW}`);
  assert.equal(await fs.readFile(path.join(directory, 'config.sh'), 'utf8'), `config.sh ${NEW}`);
  // The kit's overlay lands in the new bin/; kit-owned and slot files stay.
  assert.equal(await fs.readFile(path.join(directory, 'bin/autoscale-worker.mjs'), 'utf8'), 'overlay autoscale-worker.mjs');
  assert.equal(await fs.readFile(path.join(directory, 'bin/actions.runner.service.template'), 'utf8'), 'overlay bin/actions.runner.service.template');
  for (const [leaf, text] of [['env.sh', 'kit env.sh'], ['svc.sh', 'kit svc.sh'], ['runsvc.sh', 'kit runsvc.sh'], ['.env', 'LANG=C'], ['.path', '/usr/bin'], ['_work/repo/file', 'workspace']]) {
    assert.equal(await fs.readFile(path.join(directory, leaf), 'utf8'), text);
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, '.autoscale-slot.json'), 'utf8')).agentName, 'runner-1');
  for (const leaf of ['.autoscale-update.json', '.autoscale-update-new', '.autoscale-update-old']) assert.equal(await exists(path.join(directory, leaf)), false);
});

test('an interrupted roll finishes on the new version, and an unprovable one fails closed', async () => {
  const root = await tempDir('runner-roll-');
  const image = path.join(root, 'image');
  await runnerFiles(image, NEW);
  const overlayDir = await overlay(root);
  const directory = await slot(root, 'runner-1', OLD);
  // Simulate a crash after the journal and the first swap (bin/ moved, externals/ not yet).
  await fs.mkdir(path.join(directory, '.autoscale-update-new'));
  await fs.mkdir(path.join(directory, '.autoscale-update-old'));
  const entries = ['bin', 'config.sh', 'externals', 'run.sh', 'safe_sleep.sh'];
  for (const entry of entries) await fs.cp(path.join(image, entry), path.join(directory, '.autoscale-update-new', entry), { recursive: true });
  await fs.writeFile(path.join(directory, '.autoscale-update.json'), JSON.stringify({ version: 2, to: NEW, entries, added: [] }));
  await fs.rename(path.join(directory, 'bin'), path.join(directory, '.autoscale-update-old/bin'));
  // A listener must not start from these files.
  assert.equal(await runnerFilesVersion(directory), null);
  // Resuming needs no image: the journal and staged files carry the roll.
  assert.equal(await rollSlot(directory, { overlayDir }), NEW);
  assert.equal(await fs.readFile(path.join(directory, 'externals/node24/bin/node'), 'utf8'), `node ${NEW}`);
  assert.equal(await exists(path.join(directory, '.autoscale-update.json')), false);

  // Staged files lost after the commit point: the journal stays and the slot stays out of service.
  const broken = await slot(root, 'runner-2', OLD);
  await fs.writeFile(path.join(broken, '.autoscale-update.json'), JSON.stringify({ version: 2, to: NEW, entries: ['bin'], added: [] }));
  await fs.rm(path.join(broken, 'bin'), { recursive: true });
  await assert.rejects(rollSlot(broken, { overlayDir }), /lost an entry/);
  assert.equal(await exists(path.join(broken, '.autoscale-update.json')), true);
  // A journal naming slot state is never followed.
  await fs.writeFile(path.join(broken, '.autoscale-update.json'), JSON.stringify({ version: 2, to: NEW, entries: ['_work'], added: [] }));
  await assert.rejects(rollSlot(broken, { overlayDir }), /Invalid runner update journal/);
  assert.equal(await fs.readFile(path.join(broken, '_work/repo/file'), 'utf8'), 'workspace');
});

const stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15) + '-utc.log';
async function blockedSlot(root, dirName, version, { agentId = 11, log = 'deprecated', worker = false, extraLog = false, name = dirName } = {}) {
  const directory = await slot(root, dirName, version);
  const runner = JSON.stringify({ agentName: name, agentId, ephemeral: true, gitHubUrl: 'https://github.com/example-org' });
  await fs.writeFile(path.join(directory, '.autoscale-inflight.json'), JSON.stringify({ '.runner': runner, '.credentials': 'private-credential', '.credentials_rsaparams': 'private-key' }), { mode: 0o600 });
  await fs.writeFile(path.join(directory, '.runner'), runner, { mode: 0o600 });
  await fs.writeFile(path.join(directory, '.credentials'), 'private-credential', { mode: 0o600 });
  await fs.writeFile(path.join(directory, '.credentials_rsaparams'), 'private-key', { mode: 0o600 });
  await fs.writeFile(path.join(directory, '.autoscale-state.json'), JSON.stringify({ phase: 'blocked' }));
  const started = Date.now() + 2000;
  const diag = leaf => path.join(directory, '_diag', leaf);
  // An earlier generation's logs never count.
  await fs.writeFile(diag(`Runner_${stamp(started - 3600000)}`), 'Running job: old');
  await fs.writeFile(diag(`Worker_${stamp(started - 3600000)}`), 'old job');
  const deprecation = `[x ERR  Terminal] WRITE ERROR: An error occurred: Runner version v${version} is deprecated and cannot receive messages.\n`;
  const text = { deprecated: `Session created.\n${deprecation}`, job: `Session created.\nRunning job: build\nJob build completed with result: Canceled\n${deprecation}`,
    other: 'Session created.\nAn error occurred: Access denied\n' }[log];
  await fs.writeFile(diag(`Runner_${stamp(started)}`), text);
  if (worker) await fs.writeFile(diag(`Worker_${stamp(started + 1000)}`), 'job');
  if (extraLog) await fs.writeFile(diag(`Runner_${stamp(started + 5000)}`), text);
  return directory;
}

test('only a listener refused for a deprecated version before any job counts as deprecation-blocked', async () => {
  const root = await tempDir('runner-diagnose-');
  const deprecated = await blockedSlot(root, 'runner-1', OLD);
  assert.deepEqual(await diagnoseBlockedSlot(deprecated), { cause: 'deprecated-runner', version: OLD, agentId: 11 });
  // Every other blocked cause stays manual.
  const cases = [
    ['ran a job', { log: 'job' }],
    ['other failure', { log: 'other' }],
    ['job worker started', { worker: true }],
    ['two listeners in one generation', { extraLog: true }],
  ];
  for (const [index, [label, options]] of cases.entries()) {
    const directory = await blockedSlot(root, `case-${index}`, OLD, options);
    assert.deepEqual(await diagnoseBlockedSlot(directory), { cause: 'unknown' }, label);
  }
  // The refused version must be the one on disk.
  const mismatch = await blockedSlot(root, 'mismatch', OLD);
  await fs.writeFile(path.join(mismatch, 'bin/Runner.Listener.deps.json'), JSON.stringify({ libraries: { [`Runner.Listener/${NEW}`]: {} } }));
  assert.deepEqual(await diagnoseBlockedSlot(mismatch), { cause: 'unknown' });
  // A pending handoff, a reservation, or a roll in progress keeps it manual.
  for (const leaf of ['.autoscale-request.json', '.autoscale-reservation.json', '.autoscale-update.json']) {
    await fs.writeFile(path.join(deprecated, leaf), '{}');
    assert.deepEqual(await diagnoseBlockedSlot(deprecated), { cause: 'unknown' }, leaf);
    await fs.rm(path.join(deprecated, leaf));
  }
  // Not blocked, or no consumed handoff: nothing to recover.
  await fs.writeFile(path.join(deprecated, '.autoscale-state.json'), JSON.stringify({ phase: 'ready' }));
  assert.deepEqual(await diagnoseBlockedSlot(deprecated), { cause: 'unknown' });
  await fs.writeFile(path.join(deprecated, '.autoscale-state.json'), JSON.stringify({ phase: 'blocked' }));
  await fs.rm(path.join(deprecated, '.autoscale-inflight.json'));
  assert.deepEqual(await diagnoseBlockedSlot(deprecated), { cause: 'unknown' });
});

test('orphan registrations are removed only when offline, idle, and the same registration', () => {
  assert.deepEqual(orphanDecision('runner-1', 11, []), { action: 'gone' });
  assert.deepEqual(orphanDecision('runner-1', 11, [{ id: 11, name: 'runner-1', status: 'offline', busy: false }]), { action: 'delete', id: 11 });
  for (const remote of [[{ id: 11, name: 'runner-1', status: 'online', busy: false }], [{ id: 11, name: 'runner-1', status: 'offline', busy: true }],
    [{ id: 99, name: 'runner-1', status: 'offline', busy: false }], [{ id: 11, name: 'runner-1', status: 'offline', busy: false }, { id: 12, name: 'runner-1', status: 'offline', busy: false }]]) {
    assert.deepEqual(orphanDecision('runner-1', 11, remote), { action: 'keep' });
  }
});

test('health names deprecated slots, interrupted rolls, and a missing update', () => {
  const facts = [{ name: 'runner-1', kind: 'ephemeral', org: 'example-org', unitActive: true, phase: 'blocked', blockedCause: 'deprecated-runner' },
    { name: 'runner-2', kind: 'ephemeral', org: 'example-org', unitActive: true, phase: 'ready', updateInterrupted: true }];
  const problems = findProblems(facts, { configured: true, active: true, org: 'example-org', runnerUpdate: { version: 1, deprecated: { version: OLD } } });
  assert.ok(problems.some(p => p.kind === 'slot-blocked' && p.runner === 'runner-1' && /deprecated/.test(p.detail)));
  assert.ok(problems.some(p => p.kind === 'slot-update-interrupted' && p.runner === 'runner-2'));
  assert.ok(problems.some(p => p.kind === 'runner-deprecated'));
  const ready = findProblems(facts, { configured: true, active: true, org: 'example-org', runnerUpdate: { version: 1, deprecated: { version: OLD }, target: { version: NEW } } });
  assert.ok(!ready.some(p => p.kind === 'runner-deprecated'));
});

test('unused images are pruned; images a runner directory uses, the target and bootstrap stay', async () => {
  const root = await tempDir('runner-prune-');
  for (const version of ['2.330.0', OLD, '2.337.0', NEW]) await fs.mkdir(path.join(root, `actions-runner-linux-x64-${version}.image`));
  const directory = await slot(root, 'runner-1', OLD);
  assert.deepEqual((await pruneImages(root, linux, [directory], [NEW, '2.337.0'], { floor: NEW })).sort(compareVersions), ['2.330.0']);
  // Unknown versions prune nothing.
  const unknown = await slot(root, 'runner-2', OLD);
  await fs.rm(path.join(unknown, 'bin/Runner.Listener.deps.json'));
  await fs.mkdir(path.join(root, 'actions-runner-linux-x64-2.300.0.image'));
  assert.deepEqual(await pruneImages(root, linux, [directory, unknown], [NEW], { floor: NEW }), []);
});

test('controller recovers a deprecation-blocked slot without replaying credentials and leaves other causes blocked', { timeout: 60000 }, async () => {
  const root = await tempDir('runner-update-cli-');
  for (const file of ['bin/runnerctl-autoscale.mjs', 'lib/runnerctl-core.mjs', 'lib/runnerctl-autoscale.mjs', 'lib/runnerctl-autoscale-service.mjs',
    'lib/runnerctl-platform.mjs', 'lib/runnerctl-runner-update.mjs']) {
    await fs.mkdir(path.join(root, 'runnerctl-app', path.dirname(file)), { recursive: true });
    await fs.copyFile(new URL(`../${file}`, import.meta.url), path.join(root, 'runnerctl-app', file));
  }
  await fs.cp(new URL('../../overlay', import.meta.url), path.join(root, 'overlay'), { recursive: true });
  await fs.copyFile(new URL('../../platform.sh', import.meta.url), path.join(root, 'platform.sh'));
  const c = config({ lowLoad: 1000, highLoad: 2000, minFreeMemoryPercent: 1, minRunners: 2, maxRunners: 3 });
  await fs.writeFile(path.join(root, 'autoscale.json'), JSON.stringify(c));
  const recoverable = await blockedSlot(root, 'runner-1', OLD, { agentId: 11 });
  const manual = await blockedSlot(root, 'runner-2', OLD, { agentId: 12, log: 'job' });
  const idle = await slot(root, 'runner-3', OLD);
  for (const directory of [recoverable, manual, idle]) {
    await fs.writeFile(path.join(directory, '.service'), 'installed');
    await fs.writeFile(path.join(directory, '.cpu-quota'), '100');
    await fs.writeFile(path.join(directory, 'svc.sh'), `#!/bin/sh
case "$1" in
  status) if [ -f stopped ]; then echo Stopped; else echo 'Started:'; fi ;;
  stop) touch stopped; echo "stop $(basename "$PWD")" >> ../operations ;;
  start) rm -f stopped; echo "start $(basename "$PWD")" >> ../operations ;;
  *) echo "$1" >> ../operations ;;
esac
`);
    await fs.chmod(path.join(directory, 'svc.sh'), 0o700);
  }
  await fs.writeFile(path.join(root, 'runners.tsv'), [recoverable, manual, idle].map(d => `${path.basename(d)}\t${d}`).join('\n'));
  // An image nothing uses any more.
  await fs.mkdir(path.join(root, 'actions-runner-linux-x64-2.330.0.image'));
  const { bytes, sha256 } = await archive(NEW);
  await fs.writeFile(path.join(root, 'release.bin'), bytes);
  await fs.writeFile(path.join(root, 'mock-api.mjs'), `
    import { appendFile, readFile } from 'node:fs/promises';
    const log = line => appendFile(${JSON.stringify(path.join(root, 'operations'))}, line + '\\n');
    globalThis.fetch = async (url, options = {}) => {
      if (url.startsWith('https://github.com/actions/runner/releases/download/')) {
        await log('download');
        return new Response(await readFile(${JSON.stringify(path.join(root, 'release.bin'))}));
      }
      if (options.headers?.Authorization !== 'Bearer private-test-value') throw new Error('auth missing');
      if (url.includes('/repos/actions/runner/releases/')) return new Response(JSON.stringify(${JSON.stringify(release(NEW, sha256, sha256))}), { headers: { etag: '"v1"' } });
      if (options.method === 'DELETE') { await log('delete ' + url.split('/').pop()); return new Response(null, { status: 204 }); }
      if (options.method === 'POST') { await log('register ' + JSON.parse(options.body).name); return new Response('{}', { status: 422 }); }
      const runners = [{ id: 11, name: 'runner-1', status: 'offline', busy: false, labels: [{ name: 'self-hosted' }] },
        { id: 12, name: 'runner-2', status: 'offline', busy: false, labels: [{ name: 'self-hosted' }] }];
      const data = url.includes('/runners?') ? { runners, total_count: runners.length } :
        { workflow_runs: [], total_count: 0 };
      return new Response(JSON.stringify(data));
    };
  `);
  await fs.mkdir(path.join(root, 'test-bin'));
  await fs.writeFile(path.join(root, 'test-bin/systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const env = { ...process.env, PATH: path.join(root, 'test-bin') + ':' + process.env.PATH, RUNNER_AUTOSCALE_TOKEN: 'private-test-value' };
  const args = ['--import', path.join(root, 'mock-api.mjs'), path.join(root, 'runnerctl-app/bin/runnerctl-autoscale.mjs'), '--apply', '--once'];
  const operations = async () => (await fs.readFile(path.join(root, 'operations'), 'utf8').catch(() => '')).trim().split('\n');
  // First poll: the deprecation report forces a release check, which verifies and builds the image.
  const first = await exec(process.execPath, args, { env });
  assert.ok((await operations()).includes('download'));
  const state = JSON.parse(await fs.readFile(path.join(root, '.autoscale-runner-update.json'), 'utf8'));
  assert.equal(state.target.version, NEW);
  assert.equal(state.deprecated.version, OLD);
  assert.equal((await fs.stat(path.join(root, '.autoscale-runner-update.json'))).mode & 0o777, 0o600);
  assert.ok(!first.stdout.includes('private-test-value') && !first.stderr.includes('private-test-value'));
  // Nothing registers on a version GitHub refuses.
  assert.ok(!(await operations()).some(op => op.startsWith('register')));
  // Second poll: recover runner-1, roll idle runner-3, leave runner-2 blocked.
  // The stand-in rejects the registration that follows, so the poll exits non-zero.
  const second = await exec(process.execPath, args, { env }).catch(error => error);
  assert.ok(second.stderr.includes('1 slot(s) recovered from a deprecated runner version'));
  const ops = await operations();
  assert.ok(ops.includes('delete 11'));
  assert.ok(!ops.includes('delete 12'));
  assert.ok(ops.includes('stop runner-1'));
  assert.ok(!ops.some(op => op === 'stop runner-2' || op === 'stop runner-3'));
  for (const leaf of ['.runner', '.credentials', '.credentials_rsaparams', '.autoscale-inflight.json']) assert.equal(await exists(path.join(recoverable, leaf)), false, leaf);
  assert.equal(JSON.parse(await fs.readFile(path.join(recoverable, '.autoscale-state.json'), 'utf8')).phase, 'ready');
  assert.equal(await runnerFilesVersion(recoverable), NEW);
  assert.equal(await runnerFilesVersion(idle), NEW);
  assert.equal(await fs.readFile(path.join(recoverable, 'bin/autoscale-worker.mjs'), 'utf8'),
    await fs.readFile(new URL('../../overlay/autoscale-worker.mjs', import.meta.url), 'utf8'));
  assert.equal(await fs.readFile(path.join(recoverable, '.env'), 'utf8'), 'LANG=C');
  assert.ok((await fs.readdir(path.join(recoverable, '_diag'))).length >= 2);
  // The job-bearing slot keeps everything for manual inspection.
  assert.equal(await runnerFilesVersion(manual), OLD);
  assert.equal(JSON.parse(await fs.readFile(path.join(manual, '.autoscale-state.json'), 'utf8')).phase, 'blocked');
  for (const leaf of ['.runner', '.credentials', '.autoscale-inflight.json']) assert.equal(await exists(path.join(manual, leaf)), true, leaf);
  // runner-2 still uses the old image directory name if one existed; the unused one is gone.
  assert.equal(await exists(path.join(root, 'actions-runner-linux-x64-2.330.0.image')), false);
  assert.equal(await exists(path.join(root, `actions-runner-linux-x64-${NEW}.image`)), true);
  // A fresh registration follows on current files only, never a replay of the consumed one.
  assert.ok(ops.some(op => op.startsWith('register ')));
  assert.ok(!second.stdout.includes('private-test-value') && !second.stderr.includes('private-test-value'));
});

test('a target whose image disappeared is rebuilt even when the release answers 304', async () => {
  const root = await tempDir('runner-update-root-');
  const { bytes, sha256 } = await archive(NEW);
  const gh = mockGithub(release(NEW, sha256, sha256), bytes);
  const c = config();
  let state = await checkForUpdate({ version: 1 }, c, { root, now: 1000, fetchImpl: gh.fetchImpl, p: linux });
  const image = path.join(root, `actions-runner-linux-x64-${NEW}.image`);
  await fs.rm(image, { recursive: true });
  await fs.rm(path.join(root, `actions-runner-linux-x64-${NEW}.tar.gz`));
  assert.equal(await readyTarget(state, root), null);
  // The controller asks soon, and the 304 answer still rebuilds from the recorded checksum.
  assert.equal(checkDue(state, c, 2000, { targetMissing: true }), 'forced');
  state = await checkForUpdate(state, c, { root, now: 2000, forced: true, fetchImpl: gh.fetchImpl, p: linux });
  assert.equal(gh.calls.filter(call => call.url.includes('/releases/latest')).at(-1).etag, '"v1"');
  assert.equal(state.target.version, NEW);
  assert.deepEqual(await readyTarget(state, root), { version: NEW, image });
  // The rebuild is verified against the recorded checksum, not trusted blindly.
  await fs.rm(image, { recursive: true });
  await fs.rm(path.join(root, `actions-runner-linux-x64-${NEW}.tar.gz`));
  const tampered = await archive(NEW, 'tampered');
  const bad = mockGithub(release(NEW, sha256, sha256), tampered.bytes);
  const refused = await checkForUpdate({ ...state, etag: '"v1"' }, c, { root, now: 3000, fetchImpl: bad.fetchImpl, p: linux });
  // Repairing the current target is retried, never refused: its checksum is already verified.
  assert.equal(refused.error.kind, 'target-repair');
  assert.equal(refused.target.version, NEW);
  assert.equal(await exists(image), false);
});

test('pruning never removes the current target or a newer image a concurrent update selected', async () => {
  const root = await tempDir('runner-prune-');
  for (const version of ['2.330.0', OLD, NEW, '2.339.0']) await fs.mkdir(path.join(root, `actions-runner-linux-x64-${version}.image`));
  const directory = await slot(root, 'runner-1', OLD);
  // The poll still holds an older target in hand; the published one is newer.
  assert.deepEqual(await pruneImages(root, linux, [directory], [OLD], { floor: NEW }), ['2.330.0']);
  for (const version of [OLD, NEW, '2.339.0']) assert.equal(await exists(path.join(root, `actions-runner-linux-x64-${version}.image`)), true);
  // Without a published target, nothing is pruned.
  await fs.mkdir(path.join(root, 'actions-runner-linux-x64-2.330.0.image'));
  assert.deepEqual(await pruneImages(root, linux, [directory], [OLD]), []);
});

test('an image with a symlink leaving it is refused; links inside it are kept and never written through', async () => {
  const root = await tempDir('runner-symlink-');
  const outside = path.join(root, 'outside-file');
  await fs.writeFile(outside, 'outside');
  // Escaping links: absolute, and relative past the root.
  for (const [label, target] of [['absolute', outside], ['relative', '../../../outside-file']]) {
    const { bytes } = await archive(NEW, NEW, async content => fs.symlink(target, path.join(content, 'bin/autoscale-worker.mjs')));
    const archivePath = path.join(root, `${label}.tar.gz`);
    await fs.writeFile(archivePath, bytes);
    const image = path.join(root, `${label}.image`);
    await assert.rejects(buildImage(archivePath, image, NEW), error => error instanceof UpdateRefusal && ['image-escaping-symlink', 'image-dangling-symlink'].includes(error.reason), label);
    assert.equal(await exists(image), false);
  }
  // A link already inside an image (built before this check) also stops a roll.
  const overlayDir = await overlay(root);
  const escaping = path.join(root, 'escaping-image');
  await runnerFiles(escaping, NEW);
  await fs.symlink(outside, path.join(escaping, 'bin/autoscale-worker.mjs'));
  const directory = await slot(root, 'runner-1', OLD);
  await assert.rejects(rollSlot(directory, { image: escaping, version: NEW, overlayDir }), /image-escaping-symlink/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
  assert.equal(await runnerFilesVersion(directory), OLD);
  // npm-style links inside the image are fine, and an overlay file at a linked name replaces the link.
  const { bytes } = await archive(NEW, NEW, async content => {
    await fs.mkdir(path.join(content, 'externals/node24/lib'));
    await fs.writeFile(path.join(content, 'externals/node24/lib/npm-cli.js'), 'npm');
    await fs.symlink('../lib/npm-cli.js', path.join(content, 'externals/node24/bin/npm'));
    await fs.symlink('../config.sh', path.join(content, 'bin/autoscale-worker.mjs'));
  });
  await fs.writeFile(path.join(root, 'inside.tar.gz'), bytes);
  const image = await buildImage(path.join(root, 'inside.tar.gz'), path.join(root, 'inside.image'), NEW);
  const other = await slot(root, 'runner-2', OLD);
  assert.equal(await rollSlot(other, { image, version: NEW, overlayDir }), NEW);
  assert.equal(await fs.readFile(path.join(other, 'config.sh'), 'utf8'), `config.sh ${NEW}`);
  assert.equal((await fs.lstat(path.join(other, 'bin/autoscale-worker.mjs'))).isSymbolicLink(), false);
  assert.equal(await fs.readFile(path.join(other, 'bin/autoscale-worker.mjs'), 'utf8'), 'overlay autoscale-worker.mjs');
  assert.equal((await fs.lstat(path.join(other, 'externals/node24/bin/npm'))).isSymbolicLink(), true);
});

// The journal clearRecoveredGeneration writes: generation id plus a hash of the handoff.
async function recoveryJournal(directory, agentId) {
  const inflight = await fs.readFile(path.join(directory, '.autoscale-inflight.json'));
  await fs.writeFile(path.join(directory, '.autoscale-recovery.json'),
    JSON.stringify({ version: 2, agentId, handoffSha256: createHash('sha256').update(inflight).digest('hex') }));
}

test('a recovery interrupted after its journal finishes on the next poll without replaying credentials', async () => {
  const root = await tempDir('runner-recovery-');
  const directory = await blockedSlot(root, 'runner-1', OLD, { agentId: 11 });
  assert.equal((await diagnoseBlockedSlot(directory)).cause, 'deprecated-runner');
  // Crash after the journal and part of the clear, before the handoff and ready state.
  await recoveryJournal(directory, 11);
  await fs.rm(path.join(directory, '.runner'));
  await fs.rm(path.join(directory, '.credentials'));
  // The journal is not re-proven from evidence, and nothing rolls meanwhile.
  assert.deepEqual(await diagnoseBlockedSlot(directory), { cause: 'unknown' });
  await assert.rejects(rollSlot(directory, { image: directory, version: NEW, overlayDir: root }), /between generations/);
  assert.equal(await finishRecovery(directory), 11);
  for (const leaf of ['.runner', '.credentials', '.credentials_rsaparams', '.autoscale-inflight.json', '.autoscale-recovery.json']) {
    assert.equal(await exists(path.join(directory, leaf)), false, leaf);
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, '.autoscale-state.json'), 'utf8')).phase, 'ready');
  // A full recovery journals first, then clears.
  const fresh = await blockedSlot(root, 'runner-2', OLD, { agentId: 12 });
  assert.equal(await clearRecoveredGeneration(fresh, 12), 12);
  assert.equal(JSON.parse(await fs.readFile(path.join(fresh, '.autoscale-state.json'), 'utf8')).phase, 'ready');
  assert.equal(await exists(path.join(fresh, '.credentials')), false);
  await assert.rejects(clearRecoveredGeneration(await blockedSlot(root, 'runner-2b', OLD, { agentId: 14 }), 15), /another generation/);
  // A new handoff beside a stale journal is left alone.
  const guarded = await blockedSlot(root, 'runner-3', OLD, { agentId: 13 });
  await recoveryJournal(guarded, 13);
  await fs.writeFile(path.join(guarded, '.autoscale-request.json'), '{}');
  await assert.rejects(finishRecovery(guarded), /newer slot state/);
  assert.equal(await exists(path.join(guarded, '.autoscale-request.json')), true);
});

test('a recovery journal never deletes another generation\'s credentials or handoff', async () => {
  const root = await tempDir('runner-recovery-');
  const keepsAll = async (directory, label) => {
    await assert.rejects(finishRecovery(directory), /newer slot state/, label);
    for (const leaf of ['.runner', '.credentials', '.credentials_rsaparams', '.autoscale-inflight.json', '.autoscale-recovery.json']) {
      assert.equal(await exists(path.join(directory, leaf)), true, `${label}: ${leaf}`);
    }
  };
  // A journal for agent 11 beside agent 12's generation (no request or reservation left).
  const replaced = await blockedSlot(root, 'runner-1', OLD, { agentId: 11 });
  await recoveryJournal(replaced, 11);
  const other = await blockedSlot(root, 'other', OLD, { agentId: 12, name: 'runner-1' });
  for (const leaf of ['.runner', '.credentials', '.credentials_rsaparams', '.autoscale-inflight.json']) {
    await fs.copyFile(path.join(other, leaf), path.join(replaced, leaf));
  }
  await keepsAll(replaced, 'newer handoff');
  // The same handoff, but the controller has since recorded a newer generation.
  const published = await blockedSlot(root, 'runner-2', OLD, { agentId: 21 });
  await recoveryJournal(published, 21);
  await fs.writeFile(path.join(published, '.autoscale-generation.json'), JSON.stringify({ id: 22 }));
  await keepsAll(published, 'newer generation');
  // Credentials that differ from the journaled handoff.
  const swapped = await blockedSlot(root, 'runner-3', OLD, { agentId: 31 });
  await recoveryJournal(swapped, 31);
  await fs.writeFile(path.join(swapped, '.credentials'), 'another-credential');
  await keepsAll(swapped, 'foreign credentials');
  // Credentials left with no handoff to prove them.
  const orphaned = await blockedSlot(root, 'runner-4', OLD, { agentId: 41 });
  await recoveryJournal(orphaned, 41);
  await fs.rm(path.join(orphaned, '.autoscale-inflight.json'));
  await assert.rejects(finishRecovery(orphaned), /newer slot state/);
  assert.equal(await exists(path.join(orphaned, '.credentials')), true);
  // A running generation is never cleared.
  const running = await blockedSlot(root, 'runner-5', OLD, { agentId: 51 });
  await recoveryJournal(running, 51);
  await fs.writeFile(path.join(running, '.autoscale-state.json'), JSON.stringify({ phase: 'running' }));
  await keepsAll(running, 'running');
});

test('symlink chains that resolve outside the image, and directory links, are refused', async () => {
  const root = await tempDir('runner-chain-');
  const outside = path.join(root, 'outside-file');
  await fs.writeFile(outside, 'outside');
  const cases = {
    // Each hop stays inside lexically; the real path does not.
    'file-chain': async content => {
      await fs.symlink('..', path.join(content, 'externals/up'));
      await fs.symlink('../externals/up/../outside-file', path.join(content, 'bin/escape'));
    },
    // Sol's case: a directory link whose chain leaves the image.
    'directory-chain': async content => {
      await fs.symlink('..', path.join(content, 'externals/up'));
      await fs.rm(path.join(content, 'externals/node24/bin'), { recursive: true });
      await fs.symlink('../up/../outside', path.join(content, 'externals/node24/bin'));
    },
    // Even a directory link that stays inside is refused.
    'directory-inside': async content => fs.symlink('node24', path.join(content, 'externals/node-current')),
  };
  for (const [label, extra] of Object.entries(cases)) {
    const { bytes } = await archive(NEW, NEW, extra);
    const archivePath = path.join(root, `${label}.tar.gz`);
    await fs.writeFile(archivePath, bytes);
    const image = path.join(root, `${label}.image`);
    await assert.rejects(buildImage(archivePath, image, NEW),
      error => error instanceof UpdateRefusal && ['image-escaping-symlink', 'image-directory-symlink', 'image-dangling-symlink'].includes(error.reason), label);
    assert.equal(await exists(image), false, label);
  }
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
});

test('an existing target image with the wrong version is replaced and rebuilt on a 304', async () => {
  const root = await tempDir('runner-update-root-');
  const { bytes, sha256 } = await archive(NEW);
  const gh = mockGithub(release(NEW, sha256, sha256), bytes);
  const c = config();
  let state = await checkForUpdate({ version: 1 }, c, { root, now: 1000, fetchImpl: gh.fetchImpl, p: linux });
  const image = path.join(root, `actions-runner-linux-x64-${NEW}.image`);
  // The image directory now holds other files; the archive was damaged too.
  await fs.rm(image, { recursive: true });
  await runnerFiles(image, OLD);
  await fs.writeFile(path.join(root, `actions-runner-linux-x64-${NEW}.tar.gz`), 'damaged');
  assert.equal(await readyTarget(state, root), null);
  state = await checkForUpdate(state, c, { root, now: 2000, forced: true, fetchImpl: gh.fetchImpl, p: linux });
  assert.equal(state.refusal ?? null, null);
  assert.deepEqual(await readyTarget(state, root), { version: NEW, image });
  assert.equal(await runnerFilesVersion(image), NEW);
  // The rebuild downloaded a fresh archive and verified it against the recorded checksum.
  assert.equal(createHash('sha256').update(await fs.readFile(path.join(root, `actions-runner-linux-x64-${NEW}.tar.gz`))).digest('hex'), sha256);
  assert.deepEqual((await fs.readdir(root)).filter(n => n.startsWith('.autoscale-runner-image.')), []);
  // An image that would fail a roll's containment check is not ready either.
  await fs.symlink('..', path.join(image, 'externals/up'));
  assert.equal(await readyTarget(state, root), null);
});

test('a roll checks the staged copy, so an image changed after its check installs nothing', async () => {
  const root = await tempDir('runner-toctou-');
  const outside = path.join(root, 'outside-file');
  await fs.writeFile(outside, 'outside');
  const image = path.join(root, 'image');
  await runnerFiles(image, NEW);
  const overlayDir = await overlay(root);
  const directory = await slot(root, 'runner-1', OLD);
  // The image passes its own check; an escaping link appears in it right after (here, while it is cloned).
  const run = async (file, args, options) => {
    if (args.at(-2) === path.join(image, 'externals')) await fs.symlink(outside, path.join(image, 'externals/escape')).catch(() => {});
    return exec(file, args, options);
  };
  await assert.rejects(rollSlot(directory, { image, version: NEW, overlayDir }, { run }), /image-escaping-symlink/);
  assert.equal(await runnerFilesVersion(directory), OLD);
  assert.equal(await exists(path.join(directory, 'externals/escape')), false);
  for (const leaf of ['.autoscale-update.json', '.autoscale-update-new']) assert.equal(await exists(path.join(directory, leaf)), false, leaf);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
});

// A resumable roll: journal written, staged files ready, nothing swapped yet.
async function journaledRoll(root, name, mutateStaged = async () => {}, journal = {}) {
  const image = path.join(root, `${name}-image`);
  await runnerFiles(image, NEW);
  const directory = await slot(root, name, OLD);
  const entries = ['bin', 'config.sh', 'externals', 'run.sh', 'safe_sleep.sh'];
  await fs.mkdir(path.join(directory, '.autoscale-update-new'));
  for (const entry of entries) await fs.cp(path.join(image, entry), path.join(directory, '.autoscale-update-new', entry), { recursive: true });
  await mutateStaged(path.join(directory, '.autoscale-update-new'));
  await fs.writeFile(path.join(directory, '.autoscale-update.json'), JSON.stringify({ version: 1, to: NEW, entries, ...journal }));
  return directory;
}

test('a link added after the staged check is caught in place and the old files come back', async () => {
  const root = await tempDir('runner-final-check-');
  const outside = path.join(root, 'outside-file');
  await fs.writeFile(outside, 'outside');
  // The escaping link appears after the journal (or a crash left it there); resuming must not install it.
  const directory = await journaledRoll(root, 'runner-1', async staged => fs.symlink(outside, path.join(staged, 'externals/escape')));
  await assert.rejects(rollSlot(directory, { overlayDir: root }), /image-escaping-symlink/);
  assert.equal(await runnerFilesVersion(directory), OLD);
  assert.equal(await fs.readFile(path.join(directory, 'externals/node24/bin/node'), 'utf8'), `node ${OLD}`);
  assert.equal(await fs.lstat(path.join(directory, 'externals/escape')).then(() => true, () => false), false);
  for (const leaf of ['.autoscale-update.json', '.autoscale-update-new', '.autoscale-update-old']) assert.equal(await exists(path.join(directory, leaf)), false, leaf);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
  assert.equal(await fs.readFile(path.join(directory, '_work/repo/file'), 'utf8'), 'workspace');
  // A directory link into slot state is caught the same way.
  const inward = await journaledRoll(root, 'runner-2', async staged => fs.symlink('../_work', path.join(staged, 'bin/work')));
  await assert.rejects(rollSlot(inward, { overlayDir: root }));
  assert.equal(await runnerFilesVersion(inward), OLD);
  // An interrupted rollback resumes as a rollback, never as a roll forward.
  const halfway = await journaledRoll(root, 'runner-3', async () => {}, { rollback: true });
  await fs.mkdir(path.join(halfway, '.autoscale-update-old'));
  await fs.rename(path.join(halfway, 'externals'), path.join(halfway, '.autoscale-update-old/externals'));
  await fs.cp(path.join(halfway, '.autoscale-update-new/externals'), path.join(halfway, 'externals'), { recursive: true });
  await assert.rejects(rollSlot(halfway, { overlayDir: root }), /rolled-back/);
  assert.equal(await fs.readFile(path.join(halfway, 'externals/node24/bin/node'), 'utf8'), `node ${OLD}`);
  assert.equal(await runnerFilesVersion(halfway), OLD);
  assert.equal(await exists(path.join(halfway, '.autoscale-update.json')), false);
});

test('only an image this code built from the verified archive is trusted, with the same content checks', async () => {
  const root = await tempDir('runner-update-root-');
  // The verified archive carries a forbidden top-level .credentials file.
  const { bytes, sha256 } = await archive(NEW, NEW, async content => fs.writeFile(path.join(content, '.credentials'), 'planted'));
  const gh = mockGithub(release(NEW, sha256, sha256), bytes);
  // A same-version image built elsewhere already sits at the target path and looks valid.
  const image = path.join(root, `actions-runner-linux-x64-${NEW}.image`);
  await runnerFiles(image, NEW);
  const state = await checkForUpdate({ version: 1 }, config(), { root, now: 1000, fetchImpl: gh.fetchImpl, p: linux });
  assert.equal(state.refusal?.reason, 'image-unexpected-entry');
  assert.equal(state.target ?? null, null);
  // A recorded target without this code's image identity is not ready, however valid it looks.
  assert.equal(await readyTarget({ version: 1, target: { version: NEW, sha256, image: path.basename(image) } }, root), null);
  // A clean release builds once and is reused by identity on the next check.
  const clean = await archive(NEW);
  const good = mockGithub(release(NEW, clean.sha256, clean.sha256), clean.bytes);
  const root2 = await tempDir('runner-update-root-');
  let built = await checkForUpdate({ version: 1 }, config(), { root: root2, now: 1000, fetchImpl: good.fetchImpl, p: linux });
  const id = built.target.imageId;
  assert.ok(await readyTarget(built, root2));
  built = await checkForUpdate({ ...built, etag: null, target: built.target }, config(), { root: root2, now: 2000, fetchImpl: good.fetchImpl, p: linux });
  assert.equal(built.target.imageId, id);
});

test('special files never block validation', { timeout: 20000 }, async () => {
  const root = await tempDir('runner-fifo-');
  const settle = (promise, label) => Promise.race([promise, sleep(3000).then(() => { throw new Error(`${label} blocked`); })]);
  const image = path.join(root, 'image');
  await runnerFiles(image, NEW);
  await fs.rm(path.join(image, 'bin/Runner.Listener.deps.json'));
  await exec('mkfifo', [path.join(image, 'bin/Runner.Listener.deps.json')]);
  assert.equal(await settle(imageValid(image, NEW), 'imageValid'), false);
  assert.equal(await settle(runnerFilesVersion(image), 'runnerFilesVersion'), null);
  // A FIFO at the archive path is replaced by a verified download, not read.
  const { bytes, sha256 } = await archive(NEW);
  const gh = mockGithub(release(NEW, sha256, sha256), bytes);
  await exec('mkfifo', [path.join(root, `actions-runner-linux-x64-${NEW}.tar.gz`)]);
  const state = await settle(checkForUpdate({ version: 1 }, config(), { root, now: 1000, fetchImpl: gh.fetchImpl, p: linux }), 'checkForUpdate');
  assert.equal(state.target.version, NEW);
  assert.ok(await settle(readyTarget(state, root), 'readyTarget'));
  // Slot files: a FIFO for the journal or blocked-slot evidence fails closed, promptly.
  const directory = await slot(root, 'runner-1', OLD);
  await exec('mkfifo', [path.join(directory, '.autoscale-update.json')]);
  await assert.rejects(settle(rollSlot(directory, { overlayDir: root }), 'rollSlot'), /Unreadable runner update journal/);
  const blocked = await blockedSlot(root, 'runner-2', OLD);
  await fs.rm(path.join(blocked, '.autoscale-inflight.json'));
  await exec('mkfifo', [path.join(blocked, '.autoscale-inflight.json')]);
  assert.deepEqual(await settle(diagnoseBlockedSlot(blocked), 'diagnoseBlockedSlot'), { cause: 'unknown' });
});

test('a refused newer release never stops repairing the verified current target', async () => {
  const root = await tempDir('runner-update-root-');
  const current = await archive(NEW);
  const newer = '2.339.0';
  let latest = release(NEW, current.sha256, current.sha256);
  let tag = '"v1"';
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, etag: options.headers?.['If-None-Match'] ?? null });
    if (url.includes('/releases/latest')) {
      if (options.headers?.['If-None-Match'] === tag) return new Response(null, { status: 304 });
      return new Response(JSON.stringify(latest), { status: 200, headers: { etag: tag } });
    }
    if (url.includes(`/v${NEW}/`)) return new Response(current.bytes);
    return new Response('not found', { status: 404 });
  };
  const c = config();
  let state = await checkForUpdate({ version: 1 }, c, { root, now: 1000, fetchImpl, p: linux });
  assert.equal(state.target.version, NEW);
  // A newer release is published without an asset digest: refused, and that sticks.
  latest = release(newer, 'd'.repeat(64), null);
  tag = '"v2"';
  state = await checkForUpdate(state, c, { root, now: 2000, fetchImpl, p: linux });
  assert.equal(state.refusal.reason, 'missing-asset-digest');
  // Then the current target's image is lost; the next check answers 304 for the refused release.
  await fs.rm(path.join(root, `actions-runner-linux-x64-${NEW}.image`), { recursive: true });
  assert.equal(await readyTarget(state, root), null);
  assert.equal(checkDue(state, c, 3000, { targetMissing: true }), 'forced');
  state = await checkForUpdate(state, c, { root, now: 3000, forced: true, fetchImpl, p: linux });
  assert.equal(calls.filter(call => call.url.includes('/releases/latest')).at(-1).etag, '"v2"');
  assert.equal(state.refusal.reason, 'missing-asset-digest');
  assert.ok(await readyTarget(state, root));
  assert.equal(state.target.version, NEW);
});

test('a download that fails verification is retried without the release ETag', async () => {
  const root = await tempDir('runner-update-root-');
  const good = await archive(NEW);
  const tampered = await archive(NEW, 'tampered');
  let bytes = tampered.bytes;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, etag: options.headers?.['If-None-Match'] ?? null });
    if (url.includes('/releases/latest')) {
      if (options.headers?.['If-None-Match'] === '"v1"') return new Response(null, { status: 304 });
      return new Response(JSON.stringify(release(NEW, good.sha256, good.sha256)), { status: 200, headers: { etag: '"v1"' } });
    }
    return new Response(bytes);
  };
  const c = config();
  let state = await checkForUpdate({ version: 1 }, c, { root, now: 1000, fetchImpl, p: linux });
  assert.equal(state.refusal.reason, 'archive-checksum-mismatch');
  assert.equal(state.etag, null);
  // Retried at the forced-check interval, not every poll, and never sticky.
  assert.equal(checkDue(state, c, 1000 + FORCED_CHECK_INTERVAL_MS / 2), false);
  assert.equal(checkDue(state, c, 1000 + FORCED_CHECK_INTERVAL_MS), true);
  bytes = good.bytes;
  state = await checkForUpdate(state, c, { root, now: 1000 + FORCED_CHECK_INTERVAL_MS, fetchImpl, p: linux });
  assert.equal(calls.filter(call => call.url.includes('/releases/latest')).at(-1).etag, null);
  assert.equal(state.refusal, null);
  assert.equal(state.target.version, NEW);
  assert.ok(await readyTarget(state, root));
  // Unacceptable metadata stays refused by ETag.
  const sticky = await checkForUpdate({ version: 1 }, c, { root: await tempDir('runner-update-root-'), now: 1000,
    fetchImpl: mockGithub(release(NEW, good.sha256, null), good.bytes).fetchImpl, p: linux });
  assert.equal(sticky.refusal.retry, undefined);
  assert.equal(sticky.etag, '"v1"');
});

test('rolling back a version-1 journal removes the entries the update added', async () => {
  const root = await tempDir('runner-v1-rollback-');
  const outside = path.join(root, 'outside-file');
  await fs.writeFile(outside, 'outside');
  const directory = await journaledRoll(root, 'runner-1', async staged => {
    await fs.writeFile(path.join(staged, 'added.sh'), 'new entry');
    await fs.symlink(outside, path.join(staged, 'externals/escape'));
  });
  const journalPath = path.join(directory, '.autoscale-update.json');
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  await fs.writeFile(journalPath, JSON.stringify({ ...journal, entries: [...journal.entries, 'added.sh'] }));
  await assert.rejects(rollSlot(directory, { overlayDir: root }), /image-escaping-symlink/);
  assert.equal(await exists(path.join(directory, 'added.sh')), false);
  assert.equal(await runnerFilesVersion(directory), OLD);
  for (const leaf of ['config.sh', 'run.sh', 'safe_sleep.sh']) assert.equal(await fs.readFile(path.join(directory, leaf), 'utf8'), `${leaf} ${OLD}`);
  assert.equal(await exists(journalPath), false);
});

test('private journal writes never follow a link at the temporary name', async () => {
  const root = await tempDir('runner-tmp-link-');
  const outside = path.join(root, 'outside-file');
  await fs.writeFile(outside, 'outside');
  const image = path.join(root, 'image');
  await runnerFiles(image, NEW);
  const directory = await slot(root, 'runner-1', OLD);
  await fs.symlink(outside, path.join(directory, '.autoscale-update.json.tmp'));
  assert.equal(await rollSlot(directory, { image, version: NEW, overlayDir: await overlay(root) }), NEW);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
  // Recovery journals too.
  const blocked = await blockedSlot(root, 'runner-2', OLD, { agentId: 21 });
  await fs.symlink(outside, path.join(blocked, '.autoscale-recovery.json.tmp'));
  await fs.symlink(outside, path.join(blocked, '.autoscale-state.json.tmp'));
  assert.equal(await clearRecoveredGeneration(blocked, 21), 21);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
});

test('pruning removes downloaded archives no kept version uses', async () => {
  const root = await tempDir('runner-prune-');
  for (const version of ['2.330.0', OLD, NEW]) {
    await fs.mkdir(path.join(root, `actions-runner-linux-x64-${version}.image`));
    await fs.writeFile(path.join(root, `actions-runner-linux-x64-${version}.tar.gz`), 'archive');
  }
  await fs.writeFile(path.join(root, 'actions-runner-linux-x64-2.331.0.tar.gz'), 'archive');
  const directory = await slot(root, 'runner-1', OLD);
  assert.deepEqual((await pruneImages(root, linux, [directory], [NEW], { floor: NEW })).sort(compareVersions), ['2.330.0', '2.331.0']);
  for (const version of ['2.330.0', '2.331.0']) assert.equal(await exists(path.join(root, `actions-runner-linux-x64-${version}.tar.gz`)), false, version);
  for (const version of [OLD, NEW]) {
    assert.equal(await exists(path.join(root, `actions-runner-linux-x64-${version}.tar.gz`)), true, version);
    assert.equal(await exists(path.join(root, `actions-runner-linux-x64-${version}.image`)), true, version);
  }
});
