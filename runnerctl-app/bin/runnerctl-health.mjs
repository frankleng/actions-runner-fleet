#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseRegistry } from '../lib/runnerctl-core.mjs';
import { findProblems, planAlert, githubRunnerPath, renderAlertMarkdown, DEFAULT_THRESHOLD_MS } from '../lib/runnerctl-health.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: runnerctl health [--dry-run] [--threshold-minutes N] [--install|--uninstall]
Checks every registered runner, autoscale slot and the autoscale controller.
When a problem persists past the threshold (default 30 minutes), alerts once
per new overdue problem, and again when the fleet recovers:
- GitHub: a repository_dispatch (event runner-health) to the OWNER/REPO in
  RUNNER_HEALTH_GITHUB_REPO or .health-github-repo, whose workflow opens and
  closes issues as github-actions[bot] so you get notified
- webhook: a JSON POST to RUNNER_HEALTH_WEBHOOK_URL or the private file
  .health-webhook (mode 0600)
--dry-run prints the report without saving state or sending anything.
--install adds a systemd user timer that runs the check every 5 minutes.`);
  process.exit(0);
}
const dryRun = args.includes('--dry-run');
const thresholdIndex = args.indexOf('--threshold-minutes');
const thresholdMs = thresholdIndex >= 0 ? Number(args[thresholdIndex + 1]) * 60000 : DEFAULT_THRESHOLD_MS;
if (!Number.isFinite(thresholdMs) || thresholdMs < 0) { console.error('Invalid --threshold-minutes'); process.exit(1); }
const statePath = path.join(root, '.health-state.json');
const unitBase = `runnerctl-health-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
const unitDir = path.join(os.homedir(), '.config/systemd/user');

const exists = file => fs.access(file).then(() => true, () => false);
async function readJson(file, missing = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return missing; throw error; }
}
async function unitActive(unit) {
  try { return (await exec('systemctl', ['--user', 'is-active', unit])).stdout.trim() === 'active'; }
  catch { return false; }
}
async function privateFile(file) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) return null;
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error(`${path.basename(file)} must be a regular file owned by this user with mode 0600`);
  return (await fs.readFile(file, 'utf8')).trim() || null;
}
async function githubToken() {
  if (process.env.RUNNER_AUTOSCALE_TOKEN) return process.env.RUNNER_AUTOSCALE_TOKEN;
  const fromFile = await privateFile(process.env.RUNNER_AUTOSCALE_TOKEN_FILE || path.join(root, '.autoscale-token')).catch(() => null);
  if (fromFile) return fromFile;
  try { return (await exec('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 15000 })).stdout.trim() || null; }
  catch { return null; }
}
async function githubStatus(token, gitHubUrl, id) {
  const endpoint = githubRunnerPath(gitHubUrl, id);
  if (!token || !endpoint) return 'unknown';
  try {
    const response = await fetch(`https://api.github.com${endpoint}`, { headers: { Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (response.status === 404) return 'missing';
    if (!response.ok) return 'unknown';
    const body = await response.json();
    return body.status === 'online' ? 'online' : body.status === 'offline' ? 'offline' : 'unknown';
  } catch { return 'unknown'; }
}
async function deliveryTargets() {
  const repo = process.env.RUNNER_HEALTH_GITHUB_REPO ||
    (await fs.readFile(path.join(root, '.health-github-repo'), 'utf8').catch(() => '')).trim();
  if (repo && !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)) throw new Error('Invalid alert repository');
  const webhook = process.env.RUNNER_HEALTH_WEBHOOK_URL || await privateFile(path.join(root, '.health-webhook'));
  return { repo: repo || null, webhook };
}
async function deliver(targets, payload) {
  if (!targets.repo && !targets.webhook) throw new Error('An alert is due but no alert target is configured (.health-github-repo or .health-webhook)');
  if (targets.repo) {
    const token = await githubToken();
    if (!token) throw new Error('No GitHub token for alert delivery');
    const response = await fetch(`https://api.github.com/repos/${targets.repo}/dispatches`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'runner-health', client_payload: { host: payload.host, action: payload.action,
        title: payload.title, body: payload.markdown } }), redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Alert dispatch failed (HTTP ${response.status})`);
  }
  if (targets.webhook) {
    const response = await fetch(targets.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Alert webhook failed (HTTP ${response.status})`);
  }
}
const orgOf = url => /^https:\/\/github\.com\/([^/]+)/.exec(url ?? '')?.[1] ?? null;

async function gatherFacts() {
  const registry = parseRegistry(await fs.readFile(path.join(root, 'runners.tsv'), 'utf8'));
  const token = await githubToken();
  const facts = [];
  for (const { name, directory } of registry) {
    const slot = await readJson(path.join(directory, '.autoscale-slot.json'));
    const unitPath = (await fs.readFile(path.join(directory, '.service'), 'utf8').catch(() => '')).trim();
    const unit = unitPath ? path.basename(unitPath) : null;
    const unitText = unitPath ? await fs.readFile(unitPath, 'utf8').catch(() => '') : '';
    const fact = { name, kind: slot ? 'ephemeral' : 'persistent', unitActive: unit ? await unitActive(unit) : false,
      unitUnrendered: unitText.includes('{{') };
    if (slot) {
      fact.org = orgOf(slot.gitHubUrl);
      fact.phase = (await readJson(path.join(directory, '.autoscale-state.json'), { phase: 'ready' })).phase;
      const reservation = await fs.stat(path.join(directory, '.autoscale-reservation.json')).catch(() => null);
      if (reservation) fact.reservedSince = reservation.mtimeMs;
    } else {
      // Read only the identity fields; this file is never printed.
      const runner = await readJson(path.join(directory, '.runner'));
      fact.org = orgOf(runner?.gitHubUrl);
      fact.github = await githubStatus(token, runner?.gitHubUrl, runner?.agentId);
    }
    facts.push(fact);
  }
  const autoscaleUnit = `runnerctl-autoscale-${createHash('sha256').update(root).digest('hex').slice(0, 12)}.service`;
  const autoscaler = { configured: await exists(path.join(unitDir, autoscaleUnit)), active: await unitActive(autoscaleUnit) };
  return { facts, autoscaler, githubChecked: !!token };
}

async function install() {
  if (process.platform !== 'linux') throw new Error('--install supports systemd user services on Linux');
  if (/[^a-zA-Z0-9_./:@+-]/.test(root)) throw new Error('Unsupported kit path for a service unit');
  // Same quoting as the autoscale controller: systemd expands specifiers even in quoted strings.
  const envPath = process.env.PATH || '/usr/bin:/bin';
  if (/[\r\n\0]/.test(envPath + os.homedir())) throw new Error('Invalid service environment');
  const envQuote = s => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
  await fs.mkdir(unitDir, { recursive: true });
  await fs.writeFile(path.join(unitDir, `${unitBase}.service`), `[Unit]
Description=Runner fleet health check (${root})

[Service]
Type=oneshot
WorkingDirectory=${root}
ExecStart=${root}/runnerctl health
# gh and the GitHub keyring live outside systemd's default PATH.
Environment=${envQuote(`HOME=${os.homedir()}`)} ${envQuote(`PATH=${envPath}`)}
UMask=0077
`);
  await fs.writeFile(path.join(unitDir, `${unitBase}.timer`), `[Unit]
Description=Run the runner fleet health check every 5 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
`);
  await exec('systemctl', ['--user', 'daemon-reload']);
  await exec('systemctl', ['--user', 'enable', '--now', `${unitBase}.timer`]);
  console.log(`Installed ${unitBase}.timer`);
}

async function uninstall() {
  await exec('systemctl', ['--user', 'disable', '--now', `${unitBase}.timer`]).catch(() => {});
  await fs.rm(path.join(unitDir, `${unitBase}.timer`), { force: true });
  await fs.rm(path.join(unitDir, `${unitBase}.service`), { force: true });
  await exec('systemctl', ['--user', 'daemon-reload']);
  console.log(`Removed ${unitBase}.timer`);
}

try {
  if (args.includes('--install')) { await install(); process.exit(0); }
  if (args.includes('--uninstall')) { await uninstall(); process.exit(0); }
  const { facts, autoscaler, githubChecked } = await gatherFacts();
  const problems = findProblems(facts, autoscaler);
  const previous = await readJson(statePath, {});
  const { state, alert, resolved } = planAlert(previous, problems, Date.now(), thresholdMs);
  const report = { runners: facts.length, problems: problems.length, alerting: !!alert, resolved: !!resolved, githubChecked };
  if (dryRun) {
    console.log(JSON.stringify({ ...report, details: problems.map(({ key, ...p }) => ({ ...p, firstSeen: state.firstSeen[key] && new Date(state.firstSeen[key]).toISOString() })) }, null, 2));
    process.exit(0);
  }
  // Deliver before saving state: a failed delivery is retried on the next run.
  const host = os.hostname();
  if (alert) {
    await deliver(await deliveryTargets(), { action: 'open', host, kit: root, ...alert,
      title: `Runner fleet on ${host}: ${alert.summary}`, markdown: renderAlertMarkdown({ host, kit: root, ...alert }) });
  } else if (resolved) {
    const summary = 'All runners healthy again';
    await deliver(await deliveryTargets(), { action: 'resolve', host, kit: root, summary, problems: [],
      title: `Runner fleet on ${host}: ${summary}`, markdown: `**${summary}** as of ${new Date().toISOString()}.` });
  }
  await fs.writeFile(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
  await fs.rename(`${statePath}.tmp`, statePath);
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Health check failed');
  process.exit(1);
}
