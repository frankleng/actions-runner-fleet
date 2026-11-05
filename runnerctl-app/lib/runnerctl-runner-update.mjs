// Automatic GitHub Actions runner updates for autoscale slots.
//
// The controller finds the latest actions/runner release, downloads the
// platform archive, and trusts it only when its SHA-256 equals both the
// checksum in the release notes and the asset digest GitHub reports. A verified
// archive becomes an image next to the bootstrap one (<archive>.image). Slots
// take the new runner files only between generations: never while a listener
// or job runs, and never touching their per-generation state.
import { promises as fs, createWriteStream, constants as fsConstants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { restrictToOwner } from './runnerctl-platform.mjs';

const exec = promisify(execFile);

export const UPDATE_STATE_FILE = '.autoscale-runner-update.json';
// Slot-local files of a roll in progress. They match .autoscale*, which Git,
// the security audit, and the package builder already treat as private state.
export const SLOT_UPDATE_JOURNAL = '.autoscale-update.json';
// Written once a deprecation-blocked slot is proven and stopped, before its dead
// generation is cleared; a crash mid-clear is finished from it, not re-proven.
export const SLOT_RECOVERY_JOURNAL = '.autoscale-recovery.json';
const SLOT_UPDATE_NEW = '.autoscale-update-new';
const SLOT_UPDATE_OLD = '.autoscale-update-old';
// Release checks: a few a day, 304s are free, and a deprecation report forces
// one sooner, but never more than once per quarter hour.
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const FORCED_CHECK_INTERVAL_MS = 15 * 60 * 1000;
export const FAILURE_RETRY_MS = 30 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_DIAG_BYTES = 16 * 1024 * 1024;
const VERSION = /^\d+\.\d+\.\d+$/;
const DEPRECATED = /An error occurred: Runner version v(\d+\.\d+\.\d+) is deprecated and cannot receive messages\./;
// Any sign that the listener was offered or ran a job in this generation.
const JOB_EVIDENCE = /Running job:|Acknowledging runner request|JobDispatcher\] Job request|Received job status event/;
// Archive entries the kit owns in a slot; copy_overlay writes them, so a roll
// must not replace them with upstream copies.
const KIT_OWNED = new Set(['env.sh', 'svc.sh', 'runsvc.sh']);
// Slot state and tooling an archive entry may never replace.
const FORBIDDEN = /^(\.|_work$|_diag$|job-hooks$|tools$|home$|tmp$)/;
// copy_overlay's bin/ files: [kit overlay source, bin/ leaf].
const OVERLAY_BIN = [['runsvc.sh', 'runsvc.sh'], ['autoscale-lock.mjs', 'autoscale-lock.mjs'], ['autoscale-worker.mjs', 'autoscale-worker.mjs'],
  ['bin/actions.runner.plist.template', 'actions.runner.plist.template'],
  ['bin/actions.runner.agent.plist.template', 'actions.runner.agent.plist.template'],
  ['bin/actions.runner.service.template', 'actions.runner.service.template']];

/** A verification or release problem that keeps the current runner version. */
export class UpdateRefusal extends Error {
  constructor(reason, version = null) { super(reason); this.reason = reason; this.version = version; }
}
const updateError = (kind, status) => Object.assign(new Error(kind), { updateKind: kind, ...(status ? { status } : {}) });

/** The release asset platform for this host, or null when it is unsupported. */
export function runnerPlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'linux' && arch === 'x64') return { name: 'linux-x64', ext: 'tar.gz' };
  if (platform === 'darwin' && arch === 'arm64') return { name: 'osx-arm64', ext: 'tar.gz' };
  if (platform === 'win32' && arch === 'x64') return { name: 'win-x64', ext: 'zip' };
  return null;
}
// Windows runs each slot's supervisor with node.exe from the slot's own
// externals directory, which Windows refuses to rename while it runs. Windows
// slots stay on the pinned version (platform.ps1).
export const rollSupported = (platform = process.platform) => platform === 'linux' || platform === 'darwin';
export const archiveName = (p, version) => `actions-runner-${p.name}-${version}.${p.ext}`;
export const imageName = (p, version) => `${archiveName(p, version).replace(/\.(tar\.gz|zip)$/, '')}.image`;

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/**
 * The verified-to-be-consistent download for one platform of a release, or
 * null for drafts and prereleases, which are ignored. Throws UpdateRefusal when
 * either checksum is missing or they disagree. The URL is built from the
 * version, never taken from the response.
 */
export function releaseCandidate(release, p) {
  if (!release || typeof release !== 'object') throw new UpdateRefusal('invalid-release');
  if (release.draft !== false || release.prerelease !== false) return null;
  const tag = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? '');
  if (!tag) throw new UpdateRefusal('invalid-release');
  const version = tag[1];
  const name = archiveName(p, version);
  const marker = new RegExp(`<!-- BEGIN SHA ${p.name} -->\\s*([0-9a-fA-F]{64})\\s*<!-- END SHA ${p.name} -->`).exec(release.body ?? '');
  if (!marker) throw new UpdateRefusal('missing-notes-checksum', version);
  const assets = Array.isArray(release.assets) ? release.assets.filter(a => a?.name === name) : [];
  if (assets.length !== 1) throw new UpdateRefusal('missing-asset', version);
  const digest = /^sha256:([0-9a-fA-F]{64})$/.exec(assets[0].digest ?? '');
  if (!digest) throw new UpdateRefusal('missing-asset-digest', version);
  const sha256 = marker[1].toLowerCase();
  if (digest[1].toLowerCase() !== sha256) throw new UpdateRefusal('checksum-mismatch', version);
  return { version, sha256, name, url: `https://github.com/actions/runner/releases/download/v${version}/${name}` };
}

/** Whether the controller should ask GitHub for a release now. */
export function checkDue(state, c, now, { deprecationSeen = false, targetMissing = false } = {}) {
  if (c.runnerUpdates === 'off') return false;
  // The recorded target's image is gone or invalid: rebuild it soon, even
  // though the release check itself may only answer 304.
  if (targetMissing && !(state.error && now - state.error.lastAt < FAILURE_RETRY_MS) &&
      !(now - (state.forcedAt ?? -Infinity) < FORCED_CHECK_INTERVAL_MS)) return 'forced';
  const pin = c.runnerVersion ?? null;
  // A changed pin or mode is a different question: ask now.
  if ((state.pin ?? null) !== pin) return true;
  if (!Number.isFinite(state.checkedAt)) return true;
  if (state.error && now - state.error.lastAt < FAILURE_RETRY_MS) return false;
  if (state.error) return true;
  if (deprecationSeen && !(state.target && state.deprecated && compareVersions(state.target.version, state.deprecated.version) > 0) &&
      !(now - (state.forcedAt ?? -Infinity) < FORCED_CHECK_INTERVAL_MS)) return 'forced';
  return now - state.checkedAt >= CHECK_INTERVAL_MS;
}

/** GET the latest (or pinned) release with the stored ETag. Never logs bodies. */
const withAbort = (ms, signal) => signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms);
export async function fetchRelease({ token, pin = null, etag = null, fetchImpl = fetch, signal }) {
  const url = pin ? `https://api.github.com/repos/actions/runner/releases/tags/v${pin}` : 'https://api.github.com/repos/actions/runner/releases/latest';
  if (pin && !VERSION.test(pin)) throw new UpdateRefusal('invalid-pin');
  let response;
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...(token && !/[\r\n]/.test(token) ? { Authorization: `Bearer ${token}` } : {}), ...(etag ? { 'If-None-Match': etag } : {}) },
    redirect: 'error', signal: withAbort(15000, signal) });
  } catch { throw updateError('network'); }
  if (response.status === 304) return { status: 304 };
  if (!response.ok) throw updateError(response.status === 404 && pin ? 'pin-not-found' : [403, 429].includes(response.status) ? 'rate-limit-or-auth' : 'http', response.status);
  let release;
  try { release = await response.json(); } catch { throw updateError('invalid'); }
  return { status: 200, release, etag: response.headers?.get?.('etag') ?? null, key: url };
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of (await fs.open(file)).createReadStream()) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Download over HTTPS from github.com into the kit root and verify its
 * SHA-256. Only a verified archive is renamed into place; nothing is extracted
 * or executed before that.
 */
export async function downloadVerified(candidate, root, { fetchImpl = fetch, signal } = {}) {
  if (!/^https:\/\/github\.com\/actions\/runner\/releases\/download\/v\d+\.\d+\.\d+\/actions-runner-[a-z0-9-]+-\d+\.\d+\.\d+\.(tar\.gz|zip)$/.test(candidate.url)) {
    throw new UpdateRefusal('invalid-download-url', candidate.version);
  }
  const dest = path.join(root, candidate.name);
  if (await fs.access(dest).then(() => true, () => false)) {
    if (await sha256File(dest) === candidate.sha256) return dest;
    throw new UpdateRefusal('existing-archive-mismatch', candidate.version);
  }
  const temp = path.join(root, `.autoscale-runner-download.${randomBytes(6).toString('hex')}`);
  try {
    let response;
    try { response = await fetchImpl(candidate.url, { redirect: 'follow', signal: withAbort(20 * 60 * 1000, signal) }); }
    catch { throw updateError('download-network'); }
    if (!response.ok || !response.body) throw updateError('download-http', response.status);
    // Release assets redirect to GitHub's object storage; it must stay HTTPS.
    if (response.url && !response.url.startsWith('https://')) throw new UpdateRefusal('insecure-download', candidate.version);
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) return done(new UpdateRefusal('archive-too-large', candidate.version));
      hash.update(chunk);
      done(null, chunk);
    } });
    const body = typeof response.body.getReader === 'function' ? Readable.fromWeb(response.body) : Readable.from(response.body);
    try { await pipeline(body, meter, createWriteStream(temp, { mode: 0o600, flags: 'wx' })); }
    catch (error) { throw error instanceof UpdateRefusal ? error : updateError('download-network'); }
    if (hash.digest('hex') !== candidate.sha256) throw new UpdateRefusal('archive-checksum-mismatch', candidate.version);
    await fs.rename(temp, dest);
    return dest;
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** The runner version a directory's files belong to, read from its deps manifest; null when unknown. */
export async function runnerFilesVersion(directory) {
  try {
    const text = await fs.readFile(path.join(directory, 'bin', 'Runner.Listener.deps.json'), 'utf8');
    const match = /"Runner\.Listener\/(\d+\.\d+\.\d+)"/.exec(text);
    return match ? match[1] : null;
  } catch { return null; }
}

/**
 * Extract a verified archive next to the old image, like ensure_runner_image:
 * into a staging directory, then one rename. An existing image must already
 * hold the expected version.
 */
export async function buildImage(archive, imageDir, version, { run = exec } = {}) {
  if (await fs.access(imageDir).then(() => true, () => false)) {
    if (await runnerFilesVersion(imageDir) !== version) throw new UpdateRefusal('image-mismatch', version);
    return imageDir;
  }
  const staging = await fs.mkdtemp(path.join(path.dirname(imageDir), '.autoscale-runner-image.'));
  try {
    await run('tar', ['-xzf', archive, '-C', staging], { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
    if (await runnerFilesVersion(staging) !== version) throw new UpdateRefusal('image-mismatch', version);
    await imageEntries(staging);
    await fs.rename(staging, imageDir);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return imageDir;
}

/** Top-level archive entries a roll replaces; refuses an image that would replace slot state. */
export async function imageEntries(imageDir) {
  const names = (await fs.readdir(imageDir)).sort();
  if (!names.includes('bin') || !names.includes('externals')) throw new UpdateRefusal('image-incomplete');
  if (names.some(n => FORBIDDEN.test(n) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(n))) throw new UpdateRefusal('image-unexpected-entry');
  await assertContained(imageDir);
  return names.filter(n => !KIT_OWNED.has(n));
}

/**
 * Every entry is a regular file, a directory, or a relative symlink that
 * stays inside the image (the runner ships npm/npx/corepack links in its
 * Node.js externals). A link that leaves the image, or any other file type,
 * refuses the image: cloning preserves links, and a later write through one
 * would land outside the slot.
 */
export async function assertContained(imageDir) {
  const root = path.resolve(imageDir);
  const walk = async directory => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (entry.isFile()) continue;
      if (!entry.isSymbolicLink()) throw new UpdateRefusal('image-unexpected-file-type');
      const target = await fs.readlink(full);
      const resolved = path.resolve(path.dirname(full), target);
      if (path.isAbsolute(target) || (resolved !== root && !resolved.startsWith(root + path.sep))) throw new UpdateRefusal('image-escaping-symlink');
    }
  };
  await walk(root);
}

/** Put a kit file at `to`, replacing whatever is there (a symlink included) without following it. */
export async function replaceFile(from, to, mode = null) {
  const temp = path.join(path.dirname(to), `.autoscale-copy.${randomBytes(6).toString('hex')}`);
  try {
    await fs.copyFile(from, temp, fsConstants.COPYFILE_EXCL);
    if (mode !== null) await fs.chmod(temp, mode);
    // rename replaces the directory entry; it never writes through a link.
    await fs.rename(temp, to);
  } finally { await fs.rm(temp, { force: true }); }
}

const BLANK_STATE = { version: 1 };
export async function readUpdateState(root) {
  try {
    const state = JSON.parse(await fs.readFile(path.join(root, UPDATE_STATE_FILE), 'utf8'));
    return state?.version === 1 ? state : { ...BLANK_STATE };
  } catch { return { ...BLANK_STATE }; }
}
export async function writeUpdateState(root, state) {
  const file = path.join(root, UPDATE_STATE_FILE);
  await fs.rm(`${file}.tmp`, { force: true });
  await fs.writeFile(`${file}.tmp`, '', { mode: 0o600, flag: 'wx' });
  await restrictToOwner(`${file}.tmp`);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(state));
  await fs.rename(`${file}.tmp`, file);
}

/**
 * One release check: ask GitHub, verify, download, and build the image. The
 * state records the target only once its image exists. Failures keep the
 * current target and are recorded for `runnerctl health`.
 */
export async function checkForUpdate(state, c, { root, token, now = Date.now(), forced = false, fetchImpl = fetch, run = exec, p = runnerPlatform(), signal }) {
  const next = { ...state, version: 1, pin: c.runnerVersion ?? null, platform: p.name };
  if (forced) next.forcedAt = now;
  try {
    // A pin change invalidates the cached response.
    const sameQuestion = (state.pin ?? null) === next.pin && state.etag;
    const answer = await fetchRelease({ token, pin: next.pin, etag: sameQuestion ? state.etag : null, fetchImpl, signal });
    next.checkedAt = now;
    if (answer.status === 304) {
      // Same release as last time. A failed verification stays refused until the release changes.
      next.error = null;
      if (next.refusal) return next;
      if (!next.pendingCandidate) {
        // Nothing new upstream, but a target whose image is missing is rebuilt
        // from the checksum it was verified with.
        if (!next.target || await readyTarget(next, root)) return next;
        next.pendingCandidate = targetCandidate(next.target, p);
      }
    } else {
      next.etag = answer.etag;
      next.refusal = null;
      next.pendingCandidate = null;
      let candidate;
      try { candidate = releaseCandidate(answer.release, p); }
      catch (error) {
        if (!(error instanceof UpdateRefusal)) throw error;
        next.refusal = { version: error.version, reason: error.reason, at: now };
        next.error = null;
        return next;
      }
      next.latest = candidate?.version ?? next.latest ?? null;
      if (!candidate) { next.error = null; return next; }
      next.pendingCandidate = candidate;
    }
    const candidate = next.pendingCandidate;
    // Never move backwards: a lower latest or pin leaves newer slots alone.
    // The same version is rebuilt only when its image is missing.
    const order = next.target ? compareVersions(candidate.version, next.target.version) : 1;
    if (order < 0 || (order === 0 && await readyTarget(next, root))) {
      next.pendingCandidate = null;
      next.error = null;
      return next;
    }
    const archive = await downloadVerified(candidate, root, { fetchImpl, signal });
    const image = await buildImage(archive, path.join(root, imageName(p, candidate.version)), candidate.version, { run });
    next.target = { version: candidate.version, sha256: candidate.sha256, image: path.basename(image), at: now };
    next.pendingCandidate = null;
    next.error = null;
    return next;
  } catch (error) {
    if (error instanceof UpdateRefusal) {
      next.refusal = { version: error.version, reason: error.reason, at: now };
      next.pendingCandidate = null;
      next.error = null;
      return next;
    }
    const kind = error?.updateKind ?? 'local';
    const same = state.error?.kind === kind;
    next.error = { kind, ...(error?.status ? { status: error.status } : {}), since: same ? state.error.since : now, lastAt: now };
    return next;
  }
}

/** The download that rebuilds a recorded target, verified against its recorded checksum. */
export function targetCandidate(target, p) {
  if (!VERSION.test(target?.version ?? '') || !/^[0-9a-f]{64}$/.test(target?.sha256 ?? '')) throw new UpdateRefusal('invalid-target');
  const name = archiveName(p, target.version);
  return { version: target.version, sha256: target.sha256, name, url: `https://github.com/actions/runner/releases/download/v${target.version}/${name}` };
}

/** The image every outdated slot should take now, or null. */
export async function readyTarget(state, root) {
  const t = state.target;
  if (!t || !VERSION.test(t.version ?? '') || typeof t.image !== 'string' || t.image !== path.basename(t.image)) return null;
  const image = path.join(root, t.image);
  if (await runnerFilesVersion(image) !== t.version) return null;
  return { version: t.version, image };
}

async function cloneTree(source, dest, run) {
  for (const args of process.platform === 'darwin' ? [['-c', '-Rp'], ['-Rp']] : [['-a', '--reflink=auto'], ['-Rp']]) {
    try { await run('cp', [...args, source, dest], { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 }); return; }
    catch { await fs.rm(dest, { recursive: true, force: true }); }
  }
  throw new Error('copy failed');
}
const exists = file => fs.access(file).then(() => true, () => false);
async function writePrivateJson(file, value) {
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}

/**
 * Replace a slot's runner files with the target image. The caller guarantees a
 * generation boundary: no request, in-flight handoff, credentials, or listener.
 * Only the archive's own entries move (bin/, externals/, the top-level
 * scripts); the kit's bin/ overlay files are laid onto the new bin/ first, and
 * slot state, _work, _diag, .env and .path are never touched.
 *
 * Staging happens beside the slot. The journal is the commit point: before it,
 * an interruption leaves the old version untouched; after it, every later call
 * rolls forward to the journaled version. A journal that cannot be completed
 * throws and stays, which keeps the slot out of service until inspected.
 */
export async function rollSlot(directory, { image, version, overlayDir }, { run = exec } = {}) {
  const at = leaf => path.join(directory, leaf);
  let journal = null;
  try { journal = JSON.parse(await fs.readFile(at(SLOT_UPDATE_JOURNAL), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Unreadable runner update journal'); }
  if (!journal) {
    for (const leaf of ['.runner', '.credentials', '.credentials_rsaparams', '.autoscale-request.json', '.autoscale-inflight.json', '.autoscale-reservation.json', SLOT_RECOVERY_JOURNAL]) {
      if (await exists(at(leaf))) throw new Error('Slot holds a generation; runner files change only between generations');
    }
    const entries = await imageEntries(image);
    // Leftovers without a journal never committed; the slot still runs its old files.
    await fs.rm(at(SLOT_UPDATE_NEW), { recursive: true, force: true });
    await fs.rm(at(SLOT_UPDATE_OLD), { recursive: true, force: true });
    await fs.mkdir(at(SLOT_UPDATE_NEW), { mode: 0o700 });
    for (const entry of entries) await cloneTree(path.join(image, entry), path.join(at(SLOT_UPDATE_NEW), entry), run);
    for (const [source, leaf] of OVERLAY_BIN) {
      const from = path.join(overlayDir, source);
      if (!await exists(from)) continue;
      const bin = path.join(at(SLOT_UPDATE_NEW), 'bin');
      if (!(await fs.lstat(bin)).isDirectory()) throw new Error('Staged bin/ is not a directory');
      await replaceFile(from, path.join(bin, leaf), leaf.endsWith('.sh') ? 0o755 : null);
    }
    if (await runnerFilesVersion(at(SLOT_UPDATE_NEW)) !== version) throw new Error('Staged runner files have the wrong version');
    journal = { version: 1, to: version, entries };
    await writePrivateJson(at(SLOT_UPDATE_JOURNAL), journal);
  }
  if (journal?.version !== 1 || !VERSION.test(journal.to ?? '') || !Array.isArray(journal.entries) ||
      journal.entries.some(e => typeof e !== 'string' || FORBIDDEN.test(e) || KIT_OWNED.has(e) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(e))) {
    throw new Error('Invalid runner update journal');
  }
  await fs.mkdir(at(SLOT_UPDATE_OLD), { recursive: true, mode: 0o700 });
  for (const entry of journal.entries) {
    const current = at(entry);
    const staged = path.join(at(SLOT_UPDATE_NEW), entry);
    const old = path.join(at(SLOT_UPDATE_OLD), entry);
    if (!await exists(staged)) {
      // Already swapped in by an earlier, interrupted call.
      if (!await exists(current)) throw new Error('Runner update lost an entry');
      continue;
    }
    if (await exists(current)) {
      if (await exists(old)) throw new Error('Runner update is inconsistent');
      await fs.rename(current, old);
    }
    await fs.rename(staged, current);
  }
  if (await runnerFilesVersion(directory) !== journal.to) throw new Error('Runner update did not take effect');
  await fs.rm(at(SLOT_UPDATE_OLD), { recursive: true, force: true });
  await fs.rm(at(SLOT_UPDATE_NEW), { recursive: true, force: true });
  await fs.unlink(at(SLOT_UPDATE_JOURNAL));
  return journal.to;
}

const logTime = name => {
  const m = /^(?:Runner|Worker)_(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-utc\.log$/.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
};

/**
 * Why a blocked slot is blocked, from its own files only. Returns
 * { cause: 'deprecated-runner', version, agentId } when the evidence proves the
 * generation's listener was refused for a deprecated runner version before it
 * was offered any job; otherwise { cause: 'unknown' }. Credentials are never
 * read beyond the registration id, and nothing read here is logged.
 *
 * Proof: the slot is parked blocked with its consumed handoff and nothing
 * newer (no request, reservation, or roll in progress); exactly one listener
 * log and no job worker log started after the handoff; that log reports the
 * deprecation and shows no job message.
 */
export async function diagnoseBlockedSlot(directory) {
  const unknown = { cause: 'unknown' };
  const at = leaf => path.join(directory, leaf);
  try {
    const phase = JSON.parse(await fs.readFile(at('.autoscale-state.json'), 'utf8')).phase;
    if (phase !== 'blocked') return unknown;
    for (const leaf of ['.autoscale-request.json', '.autoscale-request.tmp', '.autoscale-reservation.json', SLOT_UPDATE_JOURNAL, SLOT_RECOVERY_JOURNAL]) {
      if (await exists(at(leaf))) return unknown;
    }
    const inflightStat = await fs.stat(at('.autoscale-inflight.json'));
    const handoff = JSON.parse(await fs.readFile(at('.autoscale-inflight.json'), 'utf8'));
    const metadata = JSON.parse(handoff['.runner']);
    const slot = JSON.parse(await fs.readFile(at('.autoscale-slot.json'), 'utf8'));
    if (metadata.ephemeral !== true || metadata.agentName !== slot.agentName || !Number.isSafeInteger(metadata.agentId) || metadata.agentId < 1) return unknown;
    // Log names carry whole seconds; the handoff predates its listener.
    const since = Math.floor(inflightStat.mtimeMs / 1000) * 1000;
    const logs = (await fs.readdir(at('_diag'))).filter(n => logTime(n) >= since);
    const runners = logs.filter(n => n.startsWith('Runner_'));
    if (runners.length !== 1 || logs.some(n => n.startsWith('Worker_'))) return unknown;
    const log = path.join(at('_diag'), runners[0]);
    if ((await fs.stat(log)).size > MAX_DIAG_BYTES) return unknown;
    const text = await fs.readFile(log, 'utf8');
    const deprecated = DEPRECATED.exec(text);
    if (!deprecated || JOB_EVIDENCE.test(text)) return unknown;
    // The refused version must be the one these files run.
    if (await runnerFilesVersion(directory) !== deprecated[1]) return unknown;
    return { cause: 'deprecated-runner', version: deprecated[1], agentId: metadata.agentId };
  } catch { return unknown; }
}

/**
 * Clear a proven deprecation-blocked generation. The caller has removed its
 * registration, stopped the slot's supervisor, and holds the worker lock. The
 * journal goes first, so an interruption leaves a slot finishRecovery()
 * completes; the consumed credentials are only ever deleted, never reused.
 */
export async function clearRecoveredGeneration(directory, agentId) {
  if (!Number.isSafeInteger(agentId) || agentId < 1) throw new Error('Invalid registration id');
  await writePrivateJson(path.join(directory, SLOT_RECOVERY_JOURNAL), { version: 1, agentId });
  return finishRecovery(directory);
}
/** Finish a journaled recovery: delete the dead generation, mark the slot ready, drop the journal. Caller holds the worker lock. */
export async function finishRecovery(directory) {
  const at = leaf => path.join(directory, leaf);
  let journal;
  try { journal = JSON.parse(await fs.readFile(at(SLOT_RECOVERY_JOURNAL), 'utf8')); }
  catch { throw new Error('Unreadable recovery journal'); }
  if (journal?.version !== 1 || !Number.isSafeInteger(journal.agentId)) throw new Error('Invalid recovery journal');
  // A new handoff or roll beside the journal is not ours to clear.
  for (const leaf of ['.autoscale-request.json', '.autoscale-reservation.json', SLOT_UPDATE_JOURNAL]) {
    if (await exists(at(leaf))) throw new Error('Recovery journal beside newer slot state');
  }
  for (const leaf of ['.runner', '.credentials', '.credentials_rsaparams', '.autoscale-inflight.json']) await fs.rm(at(leaf), { force: true });
  await writePrivateJson(at('.autoscale-state.json'), { phase: 'ready' });
  await fs.unlink(at(SLOT_RECOVERY_JOURNAL));
  return journal.agentId;
}

/**
 * Whether the orphan registration of a deprecation-blocked generation may be
 * removed: 'delete' it, treat it as already 'gone', or 'keep' the slot
 * blocked because something else holds the name or it is not idle and offline.
 */
export function orphanDecision(name, agentId, remote) {
  const matches = remote.filter(r => r?.name === name);
  if (matches.length === 0) return { action: 'gone' };
  const [r] = matches;
  if (matches.length === 1 && r.id === agentId && r.status === 'offline' && r.busy === false) return { action: 'delete', id: r.id };
  return { action: 'keep' };
}

/** The bootstrap version pinned in platform.sh, whose image manage-runners.sh clones for new slots. */
export async function bootstrapVersion(root) {
  try { return /RUNNER_VERSION="\$\{RUNNER_VERSION:-(\d+\.\d+\.\d+)\}"/.exec(await fs.readFile(path.join(root, 'platform.sh'), 'utf8'))?.[1] ?? null; }
  catch { return null; }
}

/**
 * Remove images no runner directory uses. Keeps the listed versions (target
 * and bootstrap), every image at or above `floor` (the current target, so an
 * image a concurrent update just selected is never removed), and everything
 * when any directory's version is unknown or a roll is unfinished. The caller
 * must not publish a new target while this runs.
 */
export async function pruneImages(root, p, directories, keep, { floor = null } = {}) {
  if (!floor || !VERSION.test(floor)) return [];
  const versions = new Set(keep.filter(Boolean));
  for (const directory of directories) {
    if (await exists(path.join(directory, SLOT_UPDATE_JOURNAL))) return [];
    const version = await runnerFilesVersion(directory);
    if (!version) return [];
    versions.add(version);
  }
  const pattern = new RegExp(`^actions-runner-${p.name}-(\\d+\\.\\d+\\.\\d+)\\.image$`);
  const removed = [];
  for (const name of await fs.readdir(root)) {
    const match = pattern.exec(name);
    if (!match || versions.has(match[1]) || compareVersions(match[1], floor) >= 0) continue;
    await fs.rm(path.join(root, name), { recursive: true, force: true });
    removed.push(match[1]);
  }
  return removed;
}

/** Health problems from the update state and the slots' deprecation evidence. */
export function runnerUpdateProblems(state, { deprecatedSlots = 0 } = {}) {
  const problems = [];
  if (!state || state.version !== 1) return problems;
  if (state.refusal) {
    problems.push({ kind: 'runner-update-refused', detail: `runner ${state.refusal.version ?? 'release'} refused (${state.refusal.reason}); ` +
      `keeping ${state.target?.version ?? 'the pinned bootstrap version'}`, startedAt: state.refusal.at });
  }
  if (state.error && Number.isFinite(state.error.since)) {
    problems.push({ kind: 'runner-update-failing', detail: `runner release check or download failing (${state.error.kind}${state.error.status ? `, HTTP ${state.error.status}` : ''}) ` +
      `since ${new Date(state.error.since).toISOString()}`, startedAt: state.error.since });
  }
  if (deprecatedSlots > 0 && !(state.target && state.deprecated && compareVersions(state.target.version, state.deprecated.version) > 0)) {
    problems.push({ kind: 'runner-deprecated', detail: `${deprecatedSlots} slot(s) refused by GitHub for a deprecated runner version and no verified newer runner is ready`,
      urgent: true });
  }
  return problems;
}
