#!/usr/bin/env node

import blessed from "blessed";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRunnerActivityLines,
  buildRunnerDetailLines,
  buildManageRunnersArgs,
  defaultRunnerDirectory,
  classifyGitHubRunnerTargetUrl,
  DEFAULT_GITHUB_RUNNER_SCOPE,
  getRunnerActionSequence,
  getActionDefinitions,
  getGitHubRunnerTargetUrlExample,
  getRunnerNavigationConfig,
  getRunnerSelectionEvents,
  loadTrackedRunners,
  moveSelectionIndex,
  normalizeGitHubRunnerScope,
  parseAutoRefreshInterval,
  presentServiceState,
  runCommand,
  shouldAutoRefresh,
  shouldCancelPromptOnKey,
  shouldPreservePromptFocus
} from "../lib/runnerctl-core.mjs";
import {
  buildRunnerMetricLines,
  formatBytes,
  formatCpuPercent,
  formatDuration,
  RunnerMetricsSampler
} from "../lib/runnerctl-metrics.mjs";

const __filename = fileURLToPath(import.meta.url);
const APP_DIR = path.dirname(path.dirname(__filename));
const ROOT_DIR = path.dirname(APP_DIR);
const REGISTRY_PATH = process.env.RUNNER_REGISTRY_PATH ?? path.join(ROOT_DIR, "runners.tsv");
const MANAGE_RUNNERS_PATH = path.join(ROOT_DIR, "manage-runners.sh");
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RUNNER_NAVIGATION = getRunnerNavigationConfig();
const AUTO_REFRESH_INTERVAL_MS = parseAutoRefreshInterval(
  process.env.RUNNER_DASHBOARD_REFRESH_MS
);
const metricsSampler = new RunnerMetricsSampler();

if (process.argv.includes("--help") || process.argv.includes("help")) {
  printHelp();
  process.exit(0);
}

const screen = blessed.screen({
  smartCSR: true,
  dockBorders: true,
  title: "runnerctl dashboard",
  fullUnicode: true
});

const state = {
  runners: [],
  selectedIndex: 0,
  spinnerIndex: 0,
  busy: false,
  modalOpen: false,
  statusMessage: "Ready",
  actionMessage: "No operations yet"
};

const header = blessed.box({
  top: 0,
  left: 0,
  width: "100%",
  height: 3,
  tags: true,
  style: {
    fg: "white",
    bg: 24
  },
  content: ""
});

const runnerTable = blessed.list({
  top: 3,
  left: 0,
  width: "100%",
  height: "45%",
  keys: RUNNER_NAVIGATION.keys,
  mouse: true,
  border: "line",
  label: " Runners · CPU MEM · D:R/W/s · N:IN/OUT/s · UP ",
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  scrollbar: {
    ch: " ",
    track: { bg: 236 },
    style: { bg: 45 }
  },
  style: {
    border: { fg: 45 },
    selected: { bg: 24, fg: "white" },
    item: { fg: "white" }
  }
});

const detailBox = blessed.box({
  top: "48%",
  left: 0,
  width: "55%",
  height: "44%",
  border: "line",
  label: " Runner Details ",
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  keys: true,
  mouse: true,
  scrollbar: {
    ch: " ",
    track: { bg: 236 },
    style: { bg: 45 }
  },
  style: {
    border: { fg: 81 }
  },
  content: ""
});

const outputLog = blessed.log({
  top: "48%",
  left: "55%",
  width: "45%",
  height: "44%",
  border: "line",
  label: " Service Activity ",
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  keys: true,
  mouse: true,
  scrollbar: {
    ch: " ",
    track: { bg: 236 },
    style: { bg: 208 }
  },
  style: {
    border: { fg: 208 }
  }
});

const footer = blessed.box({
  bottom: 0,
  left: 0,
  width: "100%",
  height: 3,
  tags: true,
  style: {
    fg: "white",
    bg: 17
  },
  content: ""
});

screen.append(header);
screen.append(runnerTable);
screen.append(detailBox);
screen.append(outputLog);
screen.append(footer);

bindKeys();
renderChrome();
refreshRunners().catch(handleFatalError);

const spinnerTimer = setInterval(() => {
  if (state.busy) {
    state.spinnerIndex = (state.spinnerIndex + 1) % SPINNER_FRAMES.length;
    renderChrome();
  }
}, 90);

const autoRefreshTimer = AUTO_REFRESH_INTERVAL_MS > 0
  ? setInterval(() => {
    if (!shouldAutoRefresh(state)) {
      return;
    }

    refreshRunners().catch(handleFatalError);
  }, AUTO_REFRESH_INTERVAL_MS)
  : null;

screen.on("destroy", () => {
  clearInterval(spinnerTimer);
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
  }
  metricsSampler.close();
});

process.on("exit", () => metricsSampler.close());

screen.render();
runnerTable.focus();

function printHelp() {
  console.log(`runnerctl dashboard

Usage:
  ./runnerctl
  ./runnerctl stats [--json]
  ./runnerctl --help
  ./runnerctl --cli <command>

Dashboard keys:
  n  register a runner
  i  install service for selected runner
  s  start selected runner
  x  stop selected runner
  r  refresh dashboard
  q  quit

Auto-refresh:
  RUNNER_DASHBOARD_REFRESH_MS defaults to 5000; set to 0 to disable.

Metrics:
  Each row aggregates the runner service and its descendant process tree.
  The table shows live CPU, memory, disk/network rates, and uptime.
  Select a runner for cumulative disk read/write and network transfer totals.
  Run './runnerctl stats' for a non-interactive Markdown resource table.
`);
}

function bindKeys() {
  screen.key(["q", "C-c"], shutdown);
  screen.key(["r"], () => {
    refreshRunners().catch(handleFatalError);
  });
  screen.key(["n"], () => {
    openRegisterFlow().catch(handleFatalError);
  });
  screen.key(["i"], () => {
    void runRunnerAction("install-service");
  });
  screen.key(["s"], () => {
    void runRunnerAction("start");
  });
  screen.key(["x"], () => {
    void runRunnerAction("stop");
  });
  for (const binding of RUNNER_NAVIGATION.bindings) {
    runnerTable.key(binding.keys, () => moveSelection(binding.delta));
  }

  for (const eventName of getRunnerSelectionEvents()) {
    runnerTable.on(eventName, syncSelection);
  }
}

async function refreshRunners() {
  setBusy(true, "Refreshing runners");
  const trackedRunners = await loadTrackedRunners(REGISTRY_PATH);
  state.runners = await metricsSampler.sample(trackedRunners);
  state.selectedIndex = clampIndex(state.selectedIndex, state.runners.length);
  renderTable();
  renderDetails();
  state.actionMessage = `Loaded ${state.runners.length} tracked runner${state.runners.length === 1 ? "" : "s"}`;
  const refreshLabel = AUTO_REFRESH_INTERVAL_MS > 0
    ? `auto-refresh ${AUTO_REFRESH_INTERVAL_MS / 1000}s`
    : "auto-refresh off";
  setBusy(false, `Dashboard ready · ${refreshLabel}`);
}

function renderChrome() {
  const spinner = state.busy ? SPINNER_FRAMES[state.spinnerIndex] : "•";
  header.setContent(
    `{bold}runnerctl{/bold}  {white-fg}interactive dashboard for GitHub Actions runners{/white-fg}\n` +
    `{yellow-fg}${spinner}{/yellow-fg} {white-fg}${state.statusMessage}{/white-fg}`
  );

  const actions = getActionDefinitions()
    .map((action) => `{bold}${action.key}{/bold} ${action.label}`)
    .join("   ");

  footer.setContent(
    `${actions}\n{white-fg}${state.actionMessage}{/white-fg}`
  );

  screen.render();
}

function renderTable() {
  const rows = state.runners.map((runner) => formatRunnerRow(runner));
  runnerTable.setItems(rows.length > 0 ? rows : ["No tracked runners"]);
  runnerTable.select(Math.min(state.selectedIndex, Math.max(rows.length - 1, 0)));
  screen.render();
}

function renderDetails() {
  const runner = getSelectedRunner();

  if (!runner) {
    detailBox.setContent(
      "{bold}No runner selected{/bold}\n\nTrack or register a runner to populate the dashboard."
    );
    outputLog.setContent("No runner selected");
    screen.render();
    return;
  }

  detailBox.setContent(
    buildRunnerDetailLines(
      runner,
      buildRunnerMetricLines(runner.metrics)
    ).join("\n")
  );
  renderActivityForRunner(runner);
  screen.render();
}

function getSelectedRunner() {
  return state.runners[state.selectedIndex] ?? null;
}

async function runRunnerAction(action) {
  const runner = getSelectedRunner();

  if (!runner) {
    state.actionMessage = "No runner selected";
    renderChrome();
    return;
  }

  const actions = getRunnerActionSequence(action, runner);

  if (actions.length > 1) {
    state.actionMessage = `Installing service before start for ${runner.name}`;
    renderChrome();
  }

  for (const currentAction of actions) {
    const result = await executeManageRunners(currentAction, { name: runner.name });
    if (result.code !== 0) {
      return;
    }
  }
}

async function executeManageRunners(action, payload) {
  setBusy(true, `Running ${action}`);
  const result = await runCommand(MANAGE_RUNNERS_PATH, buildManageRunnersArgs(action, payload), {
    cwd: ROOT_DIR,
    env: process.env
  });

  const lines = [
    `${timestamp()} ${action}`,
    result.stdout.trim(),
    result.stderr.trim()
  ].filter(Boolean);

  for (const line of lines) {
    outputLog.log(line);
  }

  state.actionMessage = result.code === 0
    ? `${action} completed`
    : `${action} failed with exit ${result.code}`;

  await refreshRunners();
  return result;
}

async function openRegisterFlow() {
  const name = await promptInput("Runner name", "");
  if (!name) {
    state.actionMessage = "Register cancelled";
    renderChrome();
    return;
  }

  const defaultUrl = process.env.RUNNER_DEFAULT_URL || "";
  const defaultScope = classifyGitHubRunnerTargetUrl(defaultUrl) ||
    DEFAULT_GITHUB_RUNNER_SCOPE;
  const scopeInput = await promptInput(
    "Scope (repository, organization, or enterprise)",
    defaultScope
  );
  if (!scopeInput) {
    state.actionMessage = "Register cancelled";
    renderChrome();
    return;
  }
  const scope = normalizeGitHubRunnerScope(scopeInput);
  if (!scope) {
    state.actionMessage = "Scope must be repository, organization, or enterprise";
    renderChrome();
    return;
  }

  const urlInput = await promptInput(
    `${scope} target URL`,
    classifyGitHubRunnerTargetUrl(defaultUrl) === scope ? defaultUrl : ""
  );
  if (!urlInput) {
    state.actionMessage = "Register cancelled";
    renderChrome();
    return;
  }
  const url = urlInput.trim().replace(/\/+$/, "");
  if (classifyGitHubRunnerTargetUrl(url) !== scope) {
    state.actionMessage = `Expected ${getGitHubRunnerTargetUrlExample(scope)}`;
    renderChrome();
    return;
  }

  const token = await promptInput(`${scope} registration token`, "", { secret: true });
  if (!token) {
    state.actionMessage = "Register cancelled";
    renderChrome();
    return;
  }

  state.actionMessage = `Register will create ${defaultRunnerDirectory(ROOT_DIR, name)}`;
  renderChrome();
  await executeManageRunners("register", {
    name,
    token,
    url
  });
}

function promptInput(label, initialValue, { secret = false } = {}) {
  return new Promise((resolve) => {
    let isClosing = false;
    let didClose = false;
    state.modalOpen = true;

    const overlay = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      mouse: true,
      style: {
        bg: 236,
        transparent: true
      }
    });

    const modal = blessed.box({
      parent: overlay,
      border: "line",
      height: 11,
      width: "60%",
      top: "center",
      left: "center",
      label: ` ${label} `,
      tags: true,
      keys: true,
      mouse: true,
      style: {
        border: { fg: 45 },
        bg: 17
      }
    });

    const promptLabel = blessed.text({
      parent: modal,
      top: 1,
      left: 2,
      content: `${label}:`
    });

    const input = blessed.textbox({
      parent: modal,
      top: 3,
      left: 2,
      right: 2,
      height: 1,
      censor: secret,
      inputOnFocus: false,
      keys: true,
      mouse: true,
      style: {
        bg: "black",
        fg: "white"
      }
    });

    const okay = blessed.button({
      parent: modal,
      mouse: true,
      keys: true,
      shrink: true,
      padding: {
        left: 1,
        right: 1
      },
      top: 6,
      left: 2,
      name: "okay",
      content: "Okay",
      style: {
        bg: 24,
        focus: { bg: 45 },
        hover: { bg: 45 }
      }
    });

    const cancel = blessed.button({
      parent: modal,
      mouse: true,
      keys: true,
      shrink: true,
      padding: {
        left: 1,
        right: 1
      },
      top: 6,
      left: 12,
      name: "cancel",
      content: "Cancel",
      style: {
        bg: 88,
        focus: { bg: 160 },
        hover: { bg: 160 }
      }
    });

    const refocusInput = () => {
      if (!shouldPreservePromptFocus({ isClosing })) {
        return;
      }

      setImmediate(() => {
        input.focus();
        screen.render();
      });
    };

    const closeModal = (value) => {
      if (didClose) {
        return;
      }

      didClose = true;
      state.modalOpen = false;
      overlay.destroy();
      runnerTable.focus();
      screen.render();
      resolve(value);
    };

    const originalListener = input._listener.bind(input);
    input._listener = (ch, key) => {
      if (shouldCancelPromptOnKey(key?.name)) {
        isClosing = true;
        if (input._done) {
          input._done(null, null);
        }
        return;
      }

      return originalListener(ch, key);
    };

    overlay.on("click", refocusInput);
    modal.on("click", refocusInput);
    promptLabel.on("click", refocusInput);
    okay.on("press", () => {
      isClosing = true;
      input.submit();
    });
    cancel.on("press", () => {
      isClosing = true;
      if (input._done) {
        input._done(null, null);
      }
    });

    input.setValue(initialValue);
    input.readInput((_error, value) => {
      closeModal(value ?? "");
    });
    if (input.__done) {
      input.removeListener("blur", input.__done);
    }

    input.focus();
    screen.render();
  });
}

function syncSelection() {
  state.selectedIndex = clampIndex(runnerTable.selected, state.runners.length);
  renderDetails();
  renderChrome();
}

function moveSelection(delta) {
  const nextIndex = moveSelectionIndex(state.selectedIndex, state.runners.length, delta);
  state.selectedIndex = nextIndex;
  runnerTable.select(nextIndex);
  renderDetails();
  renderChrome();
}

function renderActivityForRunner(runner) {
  outputLog.setContent(buildRunnerActivityLines(runner).join("\n"));
}

function setBusy(busy, message) {
  state.busy = busy;
  state.statusMessage = message;
  renderChrome();
}

function handleFatalError(error) {
  outputLog.log(`${timestamp()} fatal: ${error.message}`);
  state.actionMessage = "Fatal error encountered";
  setBusy(false, "Error");
}

function clampIndex(index, length) {
  if (length === 0) {
    return 0;
  }

  return Math.max(0, Math.min(index, length - 1));
}

function shorten(value, limit) {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 1)}…`;
}

function formatRunnerRow(runner) {
  const service = presentServiceState(runner.serviceState);
  const metrics = runner.metrics ?? {};
  const name = padRight(shorten(runner.name, 18), 18);
  const status = padRight(compactServiceLabel(service.label), 8);
  const cpu = padLeft(formatCpuPercent(metrics.cpuPercent), 6);
  const memory = padLeft(formatBytes(metrics.memoryBytes, { compact: true }), 5);
  const diskRead = padLeft(
    formatBytes(metrics.diskReadBytesPerSecond, { compact: true }),
    5
  );
  const diskWrite = padLeft(
    formatBytes(metrics.diskWriteBytesPerSecond, { compact: true }),
    5
  );
  const networkReceive = padLeft(
    formatBytes(metrics.networkReceiveBytesPerSecond, { compact: true }),
    5
  );
  const networkSend = padLeft(
    formatBytes(metrics.networkSendBytesPerSecond, { compact: true }),
    5
  );
  const uptime = padLeft(
    shorten(formatDuration(metrics.uptimeSeconds).replaceAll(" ", ""), 8),
    8
  );

  return (
    `${name} {${service.color}-fg}${status}` +
    `{/${service.color}-fg} ${cpu} ${memory} ` +
    `${diskRead}/${diskWrite} ${networkReceive}/${networkSend} ${uptime}`
  );
}

function compactServiceLabel(serviceLabel) {
  switch (serviceLabel) {
    case "not-installed":
      return "no-svc";
    default:
      return serviceLabel;
  }
}

function padRight(value, width) {
  if (value.length >= width) {
    return value;
  }

  return value.padEnd(width, " ");
}

function padLeft(value, width) {
  if (value.length >= width) {
    return value;
  }

  return value.padStart(width, " ");
}

function shutdown() {
  metricsSampler.close();
  screen.destroy();
  process.exit(0);
}

function timestamp() {
  return new Date().toLocaleTimeString();
}
