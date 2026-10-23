#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseRegistry } from '../lib/runnerctl-core.mjs';
import { acquireLock } from '../../overlay/autoscale-lock.mjs';
import { filePrivate, kitTaskCommandLine, POWERSHELL_ARGS, serviceActive, windowsPowerShell, windowsTaskState } from '../lib/runnerctl-platform.mjs';
import { findProblems, planAlert, groupByOrg, githubRunnerPath, renderAlertMarkdown, realProblems, DEFAULT_THRESHOLD_MS, DEFAULT_AUTOSCALE_THRESHOLD_MS } from '../lib/runnerctl-health.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: runnerctl health [--dry-run] [--threshold-minutes N] [--autoscale-threshold-minutes N] [--install|--uninstall]
Checks every registered runner, autoscale slot and the autoscale controller,
including whether the controller's GitHub calls succeed.
When a problem persists past the threshold (default 30 minutes; 10 minutes for
autoscaler GitHub auth failures, queued jobs with no online runner, and a hung
controller), alerts once per new overdue problem, and again when the fleet
recovers:
- GitHub: a repository_dispatch (event runner-health) to the OWNER/REPO in
  RUNNER_HEALTH_GITHUB_REPO or .health-github-repo, whose workflow opens and
  closes issues as github-actions[bot] so you get notified
- webhook: a JSON POST to RUNNER_HEALTH_WEBHOOK_URL or the private file
  .health-webhook (mode 0600)
--dry-run prints the report without saving state or sending anything.
--install adds a systemd user timer (Linux) or a scheduled task (Windows) that
runs the check every 5 minutes.`);
  process.exit(0);
}
const dryRun = args.includes('--dry-run');
const thresholdIndex = args.indexOf('--threshold-minutes');
const thresholdMs = thresholdIndex >= 0 ? Number(args[thresholdIndex + 1]) * 60000 : DEFAULT_THRESHOLD_MS;
if (!Number.isFinite(thresholdMs) || thresholdMs < 0) { console.error('Invalid --threshold-minutes'); process.exit(1); }
const autoscaleIndex = args.indexOf('--autoscale-threshold-minutes');
const autoscaleThresholdMs = autoscaleIndex >= 0 ? Number(args[autoscaleIndex + 1]) * 60000 : DEFAULT_AUTOSCALE_THRESHOLD_MS;
if (!Number.isFinite(autoscaleThresholdMs) || autoscaleThresholdMs < 0) { console.error('Invalid --autoscale-threshold-minutes'); process.exit(1); }
const statePath = path.join(root, '.health-state.json');
const unitBase = `runnerctl-health-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
const unitDir = path.join(os.homedir(), '.config/systemd/user');

const exists = file => fs.access(file).then(() => true, () => false);
async function readJson(file, missing = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return missing; throw error; }
}
const windows = process.platform === 'win32';
const kitTask = [...POWERSHELL_ARGS, '-File', path.join(root, 'kit-task.ps1')];
async function privateFile(file) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) return null;
  if (!await filePrivate(file, stat)) {
    throw new Error(`${path.basename(file)} must be a regular file ${windows ? 'readable only by this user' : 'owned by this user with mode 0600'}`);
  }
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
      body: JSON.stringify({ event_type: 'runner-health', client_payload: { host: payload.host, org: payload.org, action: payload.action,
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
    const fact = { name, kind: slot ? 'ephemeral' : 'persistent', unitActive: unit ? await serviceActive(unit) : false,
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
  // Windows names the controller's scheduled task without the systemd suffix.
  const autoscaleUnit = `runnerctl-autoscale-${createHash('sha256').update(root).digest('hex').slice(0, 12)}${windows ? '' : '.service'}`;
  const autoscaleConfig = await readJson(path.join(root, 'autoscale.json')).catch(() => null);
  const configured = windows ? await windowsTaskState(autoscaleUnit) !== null : await exists(path.join(unitDir, autoscaleUnit));
  // The controller's own report; unreadable counts as missing, which health reports.
  const health = await readJson(path.join(root, '.autoscale-health.json')).catch(() => null);
  const autoscaler = { configured, active: await serviceActive(autoscaleUnit),
    org: autoscaleConfig?.target?.split('/')[0] ?? null, health };
  return { facts, autoscaler, githubChecked: !!token };
}

async function install() {
  if (windows) {
    const script = fileURLToPath(import.meta.url);
    await exec(windowsPowerShell(), [...kitTask, 'install', '-Name', unitBase, '-Trigger', 'Every5Minutes',
      '-LogPath', path.join(root, '.health.log'), '-CommandLine', kitTaskCommandLine([process.execPath, script])], { windowsHide: true });
    console.log(`Installed scheduled task ${unitBase} (every 5 minutes)`);
    return;
  }
  if (process.platform !== 'linux') throw new Error('--install supports systemd user services on Linux and scheduled tasks on Windows');
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
  if (windows) {
    await exec(windowsPowerShell(), [...kitTask, 'remove', '-Name', unitBase], { windowsHide: true });
    console.log(`Removed scheduled task ${unitBase}`);
    return;
  }
  await exec('systemctl', ['--user', 'disable', '--now', `${unitBase}.timer`]).catch(() => {});
  await fs.rm(path.join(unitDir, `${unitBase}.timer`), { force: true });
  await fs.rm(path.join(unitDir, `${unitBase}.service`), { force: true });
  await exec('systemctl', ['--user', 'daemon-reload']);
  console.log(`Removed ${unitBase}.timer`);
}

let releaseLock;
try {
  if (args.includes('--install')) { await install(); process.exit(0); }
  if (args.includes('--uninstall')) { await uninstall(); process.exit(0); }
  // Overlapping runs (timer plus a manual run) would both send the same alert.
  if (!dryRun) {
    try { releaseLock = await acquireLock(root, '.health.lock'); }
    catch { throw new Error('Another health check is running'); }
  }
  const { facts, autoscaler, githubChecked } = await gatherFacts();
  const problems = findProblems(facts, autoscaler, { now: Date.now(), autoscaleThresholdMs, thresholdMs });
  // One incident per org, so each org's issue opens and closes on its own.
  const raw = await readJson(statePath, {});
  const host = os.hostname();
  // State from another host (a copied or moved kit) must not suppress or resolve this host's incidents.
  const previousByOrg = raw.host === host ? raw.orgs ?? {} : {};
  const groups = groupByOrg(problems);
  const now = Date.now();
  const plans = {};
  for (const org of new Set([...Object.keys(previousByOrg), ...Object.keys(groups)])) {
    plans[org] = planAlert(previousByOrg[org], groups[org] ?? [], now, thresholdMs);
  }
  const current = realProblems(problems);
  const report = { runners: facts.length, problems: current.length, githubChecked,
    alerting: Object.keys(plans).filter(o => plans[o].alert), resolved: Object.keys(plans).filter(o => plans[o].resolved) };
  if (dryRun) {
    console.log(JSON.stringify({ ...report, details: current.map(({ key, ...p }) => ({ ...p,
      firstSeen: new Date(plans[p.org ?? 'unknown'].state.firstSeen[key]).toISOString() })) }, null, 2));
    process.exit(0);
  }
  const saved = { host, orgs: { ...previousByOrg } };
  let failure;
  for (const [org, { state, alert, resolved }] of Object.entries(plans)) {
    try {
      if (alert) {
        await deliver(await deliveryTargets(), { action: 'open', host, org, kit: root, ...alert,
          title: `[${org}] Runner fleet on ${host}: ${alert.summary}`, markdown: renderAlertMarkdown({ host, kit: root, ...alert }) });
      } else if (resolved) {
        const summary = `All ${org} runners healthy again`;
        await deliver(await deliveryTargets(), { action: 'resolve', host, org, kit: root, summary, problems: [],
          title: `[${org}] Runner fleet on ${host}: ${summary}`, markdown: `**${summary}** as of ${new Date().toISOString()}.` });
      }
      // Save only after delivery: a failed delivery is retried on the next run.
      if (state.alerted.length || Object.keys(state.firstSeen).length) saved.orgs[org] = state;
      else delete saved.orgs[org];
    } catch (error) { failure ??= error; }
  }
  await fs.writeFile(`${statePath}.tmp`, JSON.stringify(saved), { mode: 0o600 });
  await fs.rename(`${statePath}.tmp`, statePath);
  if (failure) throw failure;
  console.log(JSON.stringify(report));
  // Exit non-zero so systemd shows the unit failed even when no alert could be sent.
  if (!githubChecked) { console.error('GitHub token unavailable; runner status unverified'); process.exitCode = 1; }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Health check failed');
  process.exitCode = 1;
} finally {
  // The lock is a listening socket; it must close or the process never exits.
  await releaseLock?.();
}
