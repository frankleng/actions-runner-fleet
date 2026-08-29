import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const RUNNER_SELECTION_EVENTS = ["select item", "select"];
export const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 5000;
export const DEFAULT_GITHUB_RUNNER_SCOPE = "organization";
export const DEFAULT_CPU_CAPACITY_PERCENT = 50;

export function getMaxCpuQuotaPercent(availableCpuCount = os.availableParallelism()) {
  const maxPercent = availableCpuCount * 100;

  if (
    !Number.isSafeInteger(availableCpuCount) ||
    availableCpuCount < 1 ||
    !Number.isSafeInteger(maxPercent)
  ) {
    return 100;
  }

  return maxPercent;
}

export function getDefaultCpuQuotaPercent(
  availableCpuCount = os.availableParallelism(),
  capacityPercent = DEFAULT_CPU_CAPACITY_PERCENT
) {
  const maxPercent = getMaxCpuQuotaPercent(availableCpuCount);

  if (!Number.isSafeInteger(capacityPercent) || capacityPercent < 1 || capacityPercent > 100) {
    capacityPercent = DEFAULT_CPU_CAPACITY_PERCENT;
  }

  return Math.max(1, Math.floor(maxPercent * capacityPercent / 100));
}

export const MAX_CPU_QUOTA_PERCENT = getMaxCpuQuotaPercent();
export const DEFAULT_CPU_QUOTA_PERCENT = getDefaultCpuQuotaPercent();
const RUNNER_NAVIGATION_BINDINGS = [
  { keys: ["up", "k"], delta: -1 },
  { keys: ["down", "j"], delta: 1 }
];

export function parseRegistry(contents) {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([name, directory]) => Boolean(name) && Boolean(directory))
    .map(([name, directory]) => ({ name, directory }));
}

export function getActionDefinitions() {
  return [
    { key: "n", label: "New Runner" },
    { key: "i", label: "Install Service" },
    { key: "s", label: "Start" },
    { key: "x", label: "Stop" },
    { key: "c", label: "CPU Limit" },
    { key: "r", label: "Refresh" },
    { key: "q", label: "Quit" }
  ];
}

export function getRunnerSelectionEvents() {
  return [...RUNNER_SELECTION_EVENTS];
}

export function getRunnerNavigationConfig() {
  return {
    keys: false,
    bindings: RUNNER_NAVIGATION_BINDINGS.map((binding) => ({
      ...binding,
      keys: [...binding.keys]
    }))
  };
}

export function normalizeGitHubRunnerScope(value) {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "1":
    case "repo":
    case "repository":
      return "repository";
    case "2":
    case "org":
    case "organization":
      return "organization";
    case "3":
    case "enterprise":
      return "enterprise";
    default:
      return null;
  }
}

export function classifyGitHubRunnerTargetUrl(value) {
  const targetUrl = String(value ?? "").trim().replace(/\/+$/, "");

  if (/^https:\/\/github\.com\/enterprises\/[A-Za-z0-9_.-]+$/.test(targetUrl)) {
    return "enterprise";
  }

  if (/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetUrl)) {
    return "repository";
  }

  if (/^https:\/\/github\.com\/[A-Za-z0-9_.-]+$/.test(targetUrl)) {
    return "organization";
  }

  return null;
}

export function getGitHubRunnerTargetUrlExample(scope) {
  switch (normalizeGitHubRunnerScope(scope)) {
    case "repository":
      return "https://github.com/OWNER/REPOSITORY";
    case "organization":
      return "https://github.com/ORGANIZATION";
    case "enterprise":
      return "https://github.com/enterprises/ENTERPRISE";
    default:
      return "";
  }
}

export function buildManageRunnersArgs(action, payload = {}) {
  switch (action) {
    case "register":
      return [
        "register",
        payload.name,
        payload.token,
        payload.url,
        payload.directory
      ].filter(Boolean);
    case "track":
      return ["track", payload.name, payload.directory].filter(Boolean);
    case "install-service":
    case "start":
    case "stop":
    case "status":
      return [action, payload.name].filter(Boolean);
    case "set-cpu-limit":
      return [action, payload.name, String(payload.cpuQuotaPercent ?? "")].filter(Boolean);
    case "list":
      return ["list"];
    default:
      throw new Error(`unsupported action: ${action}`);
  }
}

export function parseCpuQuotaPercent(value, maxPercent = MAX_CPU_QUOTA_PERCENT) {
  const normalized = String(value ?? "").trim();

  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const percent = Number(normalized);
  if (!Number.isSafeInteger(percent) || percent < 1 || percent > maxPercent) {
    return null;
  }

  return percent;
}

export function defaultRunnerDirectory(rootDir, name) {
  const sanitizedName = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  return `${rootDir}/.runners/${sanitizedName}`;
}

export function parseAutoRefreshInterval(value, fallback = DEFAULT_AUTO_REFRESH_INTERVAL_MS) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (!/^\d+$/.test(String(value))) {
    return fallback;
  }

  const interval = Number(value);
  if (!Number.isSafeInteger(interval) || (interval !== 0 && interval < 1000)) {
    return fallback;
  }

  return interval;
}

export function shouldAutoRefresh({ busy, modalOpen }) {
  return !busy && !modalOpen;
}

export function parseServiceStatusOutput(output) {
  if (/Load failed|Input\/output error|Failed:/i.test(output)) {
    return "error";
  }

  if (/Started:/i.test(output)) {
    return "running";
  }

  if (/not installed/i.test(output)) {
    return "not-installed";
  }

  if (/Disabled/i.test(output)) {
    return "disabled";
  }

  if (/Stopped/i.test(output)) {
    return "stopped";
  }

  return "error";
}

export function buildRunnerServiceName(repository, runnerName) {
  const owner = String(repository ?? "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean)
    .at(-1);
  const normalizedName = String(runnerName ?? "").replaceAll(" ", "_");

  if (!owner || !normalizedName) {
    return "";
  }

  return `actions.runner.${owner}.${normalizedName}`;
}

export function parseLaunchctlDisabledOutput(output, serviceName) {
  if (!serviceName) {
    return false;
  }

  return String(output)
    .split(/\r?\n/)
    .some((line) => line.includes(`"${serviceName}" => disabled`));
}

export function parseServicePid(output, serviceName) {
  const lines = String(output ?? "").split(/\r?\n/);
  const startedIndex = lines.findIndex((line) => /^\s*Started:\s*$/.test(line));

  if (startedIndex === -1) {
    return null;
  }

  for (const line of lines.slice(startedIndex + 1)) {
    const match = line.match(/^\s*(\d+)\s+-?\d+\s+(\S+)\s*$/);
    if (!match || (serviceName && match[2] !== serviceName)) {
      continue;
    }

    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  }

  return null;
}

export function presentServiceState(serviceState) {
  switch (serviceState) {
    case "running":
      return { label: "running", color: "green" };
    case "stopped":
      return { label: "stopped", color: "red" };
    case "disabled":
      return { label: "disabled", color: "yellow" };
    case "not-installed":
      return { label: "not-installed", color: "gray" };
    default:
      return { label: "error", color: "gray" };
  }
}

export function getRunnerActionSequence(action, runner) {
  if (action === "start" && runner.serviceState === "not-installed") {
    return ["install-service", "start"];
  }

  return [action];
}

export function buildRunnerDetailLines(runner, metricLines = []) {
  const service = presentServiceState(runner.serviceState);

  return [
    `{bold}${runner.name}{/bold}`,
    `{yellow-fg}Status{/yellow-fg} {${service.color}-fg}${service.label}{/${service.color}-fg}`,
    `{yellow-fg}CPU Limit{/yellow-fg} ${runner.cpuQuotaPercent ? `${runner.cpuQuotaPercent}%` : "unavailable"}`,
    ...metricLines,
    "",
    `{blue-fg}Directory{/blue-fg}`,
    runner.directory,
    "",
    `{blue-fg}Configured{/blue-fg} ${runner.configured ? "yes" : "no"}`,
    `{blue-fg}Service Installed{/blue-fg} ${runner.serviceInstalled ? "yes" : "no"}`,
    `{blue-fg}Work Folder{/blue-fg} ${runner.workFolder ?? "_work"}`,
    "",
    `{blue-fg}GitHub Target{/blue-fg}`,
    runner.repository
  ];
}

export function buildRunnerActivityLines(runner) {
  const service = presentServiceState(runner.serviceState);
  const outputLines = (runner.serviceStatusOutput || "No service status output available")
    .split(/\r?\n/)
    .filter(Boolean);

  return [
    `Selected runner: ${runner.name}`,
    `Current status: ${service.label}`,
    "",
    ...outputLines
  ];
}

export function moveSelectionIndex(currentIndex, length, delta) {
  if (length === 0) {
    return 0;
  }

  return Math.max(0, Math.min(currentIndex + delta, length - 1));
}

export function shouldPreservePromptFocus({ isClosing }) {
  return !isClosing;
}

export function shouldCancelPromptOnKey(keyName) {
  return keyName === "escape";
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve({
        code: 1,
        stdout,
        stderr: [stderr, error.message].filter(Boolean).join("\n")
      });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

export async function loadTrackedRunners(registryPath) {
  let contents = "";

  try {
    contents = await fs.readFile(registryPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const tracked = parseRegistry(contents);
  return Promise.all(tracked.map(async (runner) => ({
    ...runner,
    ...(await readRunnerMetadata(runner.directory))
  })));
}

export async function readRunnerMetadata(directory) {
  const runnerConfigPath = path.join(directory, ".runner");
  const servicePath = path.join(directory, ".service");
  const cpuQuotaPath = path.join(directory, ".cpu-quota");
  const configured = await fileExists(runnerConfigPath);
  const serviceInstalled = await fileExists(servicePath);

  let repository = "-";
  let workFolder = "_work";
  let serviceState = serviceInstalled ? "stopped" : "not-installed";
  let serviceStatusOutput = "";
  let serviceName = "";
  let servicePid = null;
  let cpuQuotaPercent = process.platform === "linux"
    ? parseCpuQuotaPercent(process.env.RUNNER_DEFAULT_CPU_QUOTA_PERCENT) ??
      DEFAULT_CPU_QUOTA_PERCENT
    : null;

  if (process.platform === "linux" && await fileExists(cpuQuotaPath)) {
    try {
      cpuQuotaPercent = parseCpuQuotaPercent(await fs.readFile(cpuQuotaPath, "utf8")) ??
        DEFAULT_CPU_QUOTA_PERCENT;
    } catch {
      cpuQuotaPercent = DEFAULT_CPU_QUOTA_PERCENT;
    }
  }

  if (configured) {
    try {
      const config = JSON.parse(await fs.readFile(runnerConfigPath, "utf8").then(stripBom));
      repository = config.gitHubUrl ?? "-";
      workFolder = config.workFolder ?? "_work";
      serviceName = buildRunnerServiceName(repository, config.agentName);
    } catch {
      repository = "invalid .runner";
    }
  }

  if (serviceInstalled) {
    const statusResult = await runCommand("./svc.sh", ["status"], {
      cwd: directory,
      env: process.env
    });
    serviceStatusOutput = [statusResult.stdout.trim(), statusResult.stderr.trim()]
      .filter(Boolean)
      .join("\n");
    serviceState = parseServiceStatusOutput(serviceStatusOutput);
    servicePid = parseServicePid(serviceStatusOutput, serviceName);

    if (serviceState === "stopped" && serviceName && typeof process.getuid === "function") {
      const launchctlResult = await runCommand(
        process.env.RUNNER_LAUNCHCTL_BIN ?? "launchctl",
        ["print-disabled", `gui/${process.getuid()}`],
        { env: process.env }
      );
      const launchctlOutput = [launchctlResult.stdout.trim(), launchctlResult.stderr.trim()]
        .filter(Boolean)
        .join("\n");

      if (parseLaunchctlDisabledOutput(launchctlOutput, serviceName)) {
        serviceState = "disabled";
        serviceStatusOutput = [serviceStatusOutput, "Disabled by launchd"]
          .filter(Boolean)
          .join("\n");
      }
    }
  }

  return {
    configured,
    serviceInstalled,
    serviceState,
    serviceStatusOutput,
    serviceName,
    servicePid,
    cpuQuotaPercent,
    repository,
    workFolder
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function stripBom(contents) {
  return contents.replace(/^\uFEFF/, "");
}
