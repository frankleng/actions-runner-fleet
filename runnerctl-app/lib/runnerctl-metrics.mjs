import { spawn } from "node:child_process";

import { runCommand } from "./runnerctl-core.mjs";

const DEFAULT_PS_COMMAND = "/bin/ps";
const DEFAULT_NETTOP_COMMAND = "/usr/bin/nettop";
const PROCSTATS_CHUNK_SIZE = 200;
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
const COMPACT_BYTE_UNITS = ["B", "K", "M", "G", "T", "P"];

export function parseElapsedSeconds(value) {
  const input = String(value ?? "").trim();
  if (!input) {
    return null;
  }

  const dayParts = input.split("-");
  if (dayParts.length > 2) {
    return null;
  }

  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0;
  const clock = dayParts.at(-1).split(":").map(Number);

  if (
    !Number.isInteger(days) ||
    days < 0 ||
    clock.some((part) => !Number.isInteger(part) || part < 0)
  ) {
    return null;
  }

  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (clock.length === 3) {
    [hours, minutes, seconds] = clock;
  } else if (clock.length === 2) {
    [minutes, seconds] = clock;
  } else if (clock.length === 1) {
    [seconds] = clock;
  } else {
    return null;
  }

  if (minutes >= 60 || seconds >= 60) {
    return null;
  }

  return (days * 86400) + (hours * 3600) + (minutes * 60) + seconds;
}

export function parseProcessList(output) {
  return String(output ?? "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(
        /^\s*(\d+)\s+(\d+)\s+([0-9.,]+)\s+(\d+)\s+(\S+)\s+(.+)$/
      );

      if (!match) {
        return null;
      }

      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      const cpuPercent = Number(match[3].replace(",", "."));
      const residentKiB = Number(match[4]);
      const elapsedSeconds = parseElapsedSeconds(match[5]);

      if (
        !Number.isSafeInteger(pid) ||
        !Number.isSafeInteger(parentPid) ||
        !Number.isFinite(cpuPercent) ||
        !Number.isSafeInteger(residentKiB) ||
        elapsedSeconds === null
      ) {
        return null;
      }

      return {
        pid,
        parentPid,
        cpuPercent,
        residentBytes: residentKiB * 1024,
        elapsedSeconds,
        command: match[6]
      };
    })
    .filter(Boolean);
}

export function parseProcStatsOutput(output) {
  const stats = new Map();

  for (const line of String(output ?? "").split(/\r?\n/)) {
    const fields = line.trim().split("\t");
    if (fields.length !== 6) {
      continue;
    }

    const [
      pidValue,
      startToken,
      residentBytesValue,
      physicalFootprintBytesValue,
      diskReadBytesValue,
      diskWriteBytesValue
    ] = fields;
    const pid = Number(pidValue);
    const residentBytes = Number(residentBytesValue);
    const physicalFootprintBytes = Number(physicalFootprintBytesValue);
    const diskReadBytes = Number(diskReadBytesValue);
    const diskWriteBytes = Number(diskWriteBytesValue);

    if (
      !Number.isSafeInteger(pid) ||
      !startToken ||
      ![residentBytes, physicalFootprintBytes, diskReadBytes, diskWriteBytes]
        .every((value) => Number.isFinite(value) && value >= 0)
    ) {
      continue;
    }

    stats.set(pid, {
      pid,
      startToken,
      residentBytes,
      physicalFootprintBytes,
      diskReadBytes,
      diskWriteBytes
    });
  }

  return stats;
}

export function parseNettopRecord(line) {
  const match = String(line ?? "").match(/^.*\.(\d+),(\d+),(\d+),\s*$/);
  if (!match) {
    return null;
  }

  const pid = Number(match[1]);
  const receivedBytes = Number(match[2]);
  const sentBytes = Number(match[3]);

  if (
    !Number.isSafeInteger(pid) ||
    !Number.isFinite(receivedBytes) ||
    !Number.isFinite(sentBytes)
  ) {
    return null;
  }

  return {
    pid,
    receivedBytes,
    sentBytes
  };
}

export function collectDescendantProcessIds(rootPids, processes) {
  const childrenByParent = new Map();

  for (const processInfo of processes) {
    const children = childrenByParent.get(processInfo.parentPid) ?? [];
    children.push(processInfo.pid);
    childrenByParent.set(processInfo.parentPid, children);
  }

  const collected = new Set();
  const pending = [...rootPids];

  while (pending.length > 0) {
    const pid = pending.pop();
    if (collected.has(pid)) {
      continue;
    }

    collected.add(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }

  return collected;
}

export function findRunnerProcessIds(runner, processes) {
  const processByPid = new Map(processes.map((processInfo) => [
    processInfo.pid,
    processInfo
  ]));
  const rootPids = new Set();

  if (
    Number.isSafeInteger(runner.servicePid) &&
    processByPid.has(runner.servicePid)
  ) {
    rootPids.add(runner.servicePid);
  }

  const directoryPrefix = `${String(runner.directory ?? "").replace(/\/+$/, "")}/`;
  if (directoryPrefix !== "/") {
    for (const processInfo of processes) {
      if (processInfo.command.includes(directoryPrefix)) {
        rootPids.add(processInfo.pid);
      }
    }
  }

  return collectDescendantProcessIds(rootPids, processes);
}

export function aggregateRunnerProcesses(
  processIds,
  processes,
  procStats,
  networkStats
) {
  const processByPid = new Map(processes.map((processInfo) => [
    processInfo.pid,
    processInfo
  ]));
  const diskCounters = new Map();
  const networkCounters = new Map();
  let cpuPercent = 0;
  let memoryBytes = 0;
  let uptimeSeconds = null;
  let processCount = 0;

  for (const pid of processIds) {
    const processInfo = processByPid.get(pid);
    if (!processInfo) {
      continue;
    }

    processCount += 1;
    cpuPercent += processInfo.cpuPercent;
    memoryBytes += processInfo.residentBytes;
    uptimeSeconds = Math.max(uptimeSeconds ?? 0, processInfo.elapsedSeconds);

    const nativeStats = procStats.get(pid);
    const processKey = nativeStats?.startToken
      ? `${pid}:${nativeStats.startToken}`
      : String(pid);

    if (nativeStats) {
      diskCounters.set(processKey, {
        readBytes: nativeStats.diskReadBytes,
        writeBytes: nativeStats.diskWriteBytes
      });
    }

    const network = networkStats.get(pid);
    if (network) {
      networkCounters.set(String(pid), {
        readBytes: network.receivedBytes,
        writeBytes: network.sentBytes
      });
    }
  }

  return {
    cpuPercent,
    memoryBytes,
    uptimeSeconds,
    processCount,
    diskCounters,
    networkCounters
  };
}

export function advanceCumulativeCounters(previousState, currentCounters, sampledAtMs) {
  if (!Number.isFinite(sampledAtMs)) {
    return previousState;
  }

  const current = new Map(currentCounters);

  if (!previousState?.initialized) {
    const baseline = sumCounters(current);
    return {
      initialized: true,
      sampledAtMs,
      previous: current,
      totalReadBytes: baseline.readBytes,
      totalWriteBytes: baseline.writeBytes,
      readBytesPerSecond: 0,
      writeBytesPerSecond: 0
    };
  }

  if (sampledAtMs <= previousState.sampledAtMs) {
    return previousState;
  }

  let readDelta = 0;
  let writeDelta = 0;

  for (const [key, counters] of current) {
    const previous = previousState.previous.get(key);
    readDelta += counterDelta(counters.readBytes, previous?.readBytes);
    writeDelta += counterDelta(counters.writeBytes, previous?.writeBytes);
  }

  const elapsedSeconds = (sampledAtMs - previousState.sampledAtMs) / 1000;

  return {
    initialized: true,
    sampledAtMs,
    previous: current,
    totalReadBytes: previousState.totalReadBytes + readDelta,
    totalWriteBytes: previousState.totalWriteBytes + writeDelta,
    readBytesPerSecond: readDelta / elapsedSeconds,
    writeBytesPerSecond: writeDelta / elapsedSeconds
  };
}

export function formatBytes(value, { compact = false } = {}) {
  if (!Number.isFinite(value) || value < 0) {
    return "—";
  }

  const units = compact ? COMPACT_BYTE_UNITS : BYTE_UNITS;
  let scaled = value;
  let unitIndex = 0;

  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }

  const decimals = scaled >= 100 || unitIndex === 0
    ? 0
    : scaled >= 10
      ? 1
      : 2;
  const formatted = decimals === 0
    ? scaled.toFixed(0)
    : scaled.toFixed(decimals).replace(/\.?0+$/, "");

  return compact
    ? `${formatted}${units[unitIndex]}`
    : `${formatted} ${units[unitIndex]}`;
}

export function formatRate(value, options) {
  const formatted = formatBytes(value, options);
  return formatted === "—" ? formatted : `${formatted}/s`;
}

export function formatCpuPercent(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "—";
  }

  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)}%`;
}

export function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "—";
  }

  const totalSeconds = Math.floor(value);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${String(hours).padStart(2, "0")}h`;
  }

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }

  return `${seconds}s`;
}

export function buildRunnerMetricLines(metrics) {
  if (!metrics?.available) {
    return [
      `{blue-fg}Resources{/blue-fg} ${metrics?.error || "unavailable"}`
    ];
  }

  const diskRate = metrics.diskAvailable
    ? `R ${formatRate(metrics.diskReadBytesPerSecond)}  W ${formatRate(metrics.diskWriteBytesPerSecond)}`
    : metrics.diskError || "unavailable";
  const networkRate = metrics.networkAvailable
    ? `In ${formatRate(metrics.networkReceiveBytesPerSecond)}  Out ${formatRate(metrics.networkSendBytesPerSecond)}`
    : metrics.networkStatus === "starting"
      ? "starting (5-10s)"
      : metrics.networkError || "unavailable";
  const diskTotal = metrics.diskAvailable
    ? `R ${formatBytes(metrics.diskReadBytes)}  W ${formatBytes(metrics.diskWriteBytes)}`
    : "unavailable";
  const networkTotal = metrics.networkAvailable
    ? `In ${formatBytes(metrics.networkReceiveBytes)}  Out ${formatBytes(metrics.networkSendBytes)}`
    : "unavailable";

  return [
    `{blue-fg}CPU{/blue-fg} ${formatCpuPercent(metrics.cpuPercent)}  ` +
      `{blue-fg}RSS{/blue-fg} ${formatBytes(metrics.memoryBytes)}  ` +
      `{blue-fg}Procs{/blue-fg} ${metrics.processCount}`,
    `{blue-fg}Uptime{/blue-fg} ${formatDuration(metrics.uptimeSeconds)}`,
    `{blue-fg}Disk/s{/blue-fg} ${diskRate}`,
    `{blue-fg}Net/s{/blue-fg} ${networkRate}`,
    `{blue-fg}Disk total{/blue-fg} ${diskTotal}`,
    `{blue-fg}Net total{/blue-fg} ${networkTotal}`
  ];
}

export class RunnerMetricsSampler {
  constructor(options = {}) {
    this.psCommand = optionValue(
      options,
      "psCommand",
      process.env.RUNNER_PS_BIN || DEFAULT_PS_COMMAND
    );
    this.procStatsCommand = optionValue(
      options,
      "procStatsCommand",
      process.env.RUNNER_PROCSTATS_BIN || ""
    );
    this.nettopCommand = optionValue(
      options,
      "nettopCommand",
      process.env.RUNNER_NETTOP_BIN || DEFAULT_NETTOP_COMMAND
    );
    this.platform = optionValue(options, "platform", process.platform);
    this.now = options.now ?? (() => Date.now());
    this.run = options.runCommand ?? runCommand;
    this.spawn = options.spawn ?? spawn;
    this.runnerStates = new Map();
    this.networkProcess = null;
    this.networkRestartTimer = null;
    this.networkStarted = false;
    this.networkStatus = "starting";
    this.networkError = "";
    this.networkBuffer = "";
    this.pendingNetworkStats = null;
    this.pendingNetworkSampledAtMs = null;
    this.networkStats = new Map();
    this.networkSampledAtMs = null;
    this.closed = false;
  }

  async sample(runners) {
    this.startNetworkMonitor();

    const processResult = await this.run(
      this.psCommand,
      ["-ww", "-axo", "pid=,ppid=,%cpu=,rss=,etime=,command="],
      {
        env: {
          ...process.env,
          LC_ALL: "C"
        }
      }
    );

    if (processResult.code !== 0) {
      const error = processResult.stderr.trim() || "ps failed";
      return runners.map((runner) => ({
        ...runner,
        metrics: {
          available: false,
          error
        }
      }));
    }

    const sampledAtMs = this.now();
    const processes = parseProcessList(processResult.stdout);
    const processIdsByRunner = new Map();
    const allRunnerProcessIds = new Set();

    for (const runner of runners) {
      const processIds = findRunnerProcessIds(runner, processes);
      processIdsByRunner.set(runner.directory, processIds);
      for (const pid of processIds) {
        allRunnerProcessIds.add(pid);
      }
    }

    const procStatsResult = await this.loadProcStats([...allRunnerProcessIds]);
    const activeRunnerKeys = new Set(runners.map((runner) => runner.directory));

    for (const key of this.runnerStates.keys()) {
      if (!activeRunnerKeys.has(key)) {
        this.runnerStates.delete(key);
      }
    }

    return runners.map((runner) => {
      const processIds = processIdsByRunner.get(runner.directory) ?? new Set();
      const aggregate = aggregateRunnerProcesses(
        processIds,
        processes,
        procStatsResult.stats,
        this.networkStats
      );
      const runnerState = this.runnerStates.get(runner.directory) ?? {
        disk: null,
        network: null
      };

      if (procStatsResult.available) {
        runnerState.disk = advanceCumulativeCounters(
          runnerState.disk,
          aggregate.diskCounters,
          sampledAtMs
        );
      }

      if (this.networkStatus === "ready" && this.networkSampledAtMs !== null) {
        runnerState.network = advanceCumulativeCounters(
          runnerState.network,
          aggregate.networkCounters,
          this.networkSampledAtMs
        );
      }

      this.runnerStates.set(runner.directory, runnerState);

      return {
        ...runner,
        metrics: {
          available: true,
          cpuPercent: aggregate.cpuPercent,
          memoryBytes: aggregate.memoryBytes,
          processCount: aggregate.processCount,
          uptimeSeconds: aggregate.uptimeSeconds,
          diskAvailable: procStatsResult.available,
          diskError: procStatsResult.error,
          diskReadBytesPerSecond: runnerState.disk?.readBytesPerSecond ?? null,
          diskWriteBytesPerSecond: runnerState.disk?.writeBytesPerSecond ?? null,
          diskReadBytes: runnerState.disk?.totalReadBytes ?? null,
          diskWriteBytes: runnerState.disk?.totalWriteBytes ?? null,
          networkAvailable: this.networkStatus === "ready",
          networkStatus: this.networkStatus,
          networkError: this.networkError,
          networkReceiveBytesPerSecond:
            runnerState.network?.readBytesPerSecond ?? null,
          networkSendBytesPerSecond:
            runnerState.network?.writeBytesPerSecond ?? null,
          networkReceiveBytes: runnerState.network?.totalReadBytes ?? null,
          networkSendBytes: runnerState.network?.totalWriteBytes ?? null
        }
      };
    });
  }

  close() {
    this.closed = true;
    if (this.networkRestartTimer) {
      clearTimeout(this.networkRestartTimer);
      this.networkRestartTimer = null;
    }
    if (this.networkProcess && !this.networkProcess.killed) {
      this.networkProcess.kill("SIGTERM");
    }
    this.networkProcess = null;
  }

  startNetworkMonitor() {
    if (this.networkStarted || this.closed) {
      return;
    }

    this.networkStarted = true;
    if (this.platform !== "darwin" || !this.nettopCommand) {
      this.networkStatus = "unavailable";
      this.networkError = "nettop is only available on macOS";
      return;
    }

    if (this.networkStatus === "unavailable") {
      this.networkStatus = "starting";
      this.networkError = "";
    }

    try {
      const child = this.spawn(
        this.nettopCommand,
        [
          "-P",
          "-L",
          "1",
          "-x",
          "-s",
          "1",
          "-J",
          "bytes_in,bytes_out"
        ],
        {
          env: {
            ...process.env,
            LC_ALL: "C"
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      this.networkProcess = child;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => this.ingestNetworkChunk(chunk));
      child.stderr.on("data", (chunk) => {
        this.networkError = appendLimited(this.networkError, chunk, 500);
      });
      child.on("error", (error) => {
        this.networkStatus = "unavailable";
        this.networkError = error.message;
      });
      child.on("close", (code) => {
        if (this.networkBuffer) {
          this.ingestNetworkChunk("\n");
        }
        this.networkProcess = null;
        this.networkStarted = false;

        if (this.closed) {
          return;
        }

        if (code !== 0) {
          this.networkStatus = "unavailable";
          this.networkError = `nettop exited with status ${code ?? "unknown"}`;
        }

        this.networkRestartTimer = setTimeout(() => {
          this.networkRestartTimer = null;
          this.startNetworkMonitor();
        }, code === 0 ? 0 : 5000);
      });
    } catch (error) {
      this.networkStatus = "unavailable";
      this.networkError = error.message;
    }
  }

  ingestNetworkChunk(chunk) {
    this.networkBuffer += chunk;
    const lines = this.networkBuffer.split(/\r?\n/);
    this.networkBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith(",bytes_in,bytes_out")) {
        this.pendingNetworkStats = new Map();
        this.pendingNetworkSampledAtMs = this.now();
        continue;
      }

      const record = parseNettopRecord(line);
      if (!record || !this.pendingNetworkStats) {
        continue;
      }

      this.pendingNetworkStats.set(record.pid, record);
      this.networkStats = this.pendingNetworkStats;
      this.networkSampledAtMs = this.pendingNetworkSampledAtMs;
      this.networkStatus = "ready";
      this.networkError = "";
    }
  }

  async loadProcStats(processIds) {
    if (!this.procStatsCommand) {
      return {
        available: false,
        error: "disk helper unavailable (install Xcode Command Line Tools)",
        stats: new Map()
      };
    }

    if (processIds.length === 0) {
      return {
        available: true,
        error: "",
        stats: new Map()
      };
    }

    const chunks = [];
    for (let index = 0; index < processIds.length; index += PROCSTATS_CHUNK_SIZE) {
      chunks.push(processIds.slice(index, index + PROCSTATS_CHUNK_SIZE));
    }

    const results = await Promise.all(chunks.map((chunk) => (
      this.run(this.procStatsCommand, chunk.map(String), { env: process.env })
    )));
    const failedResult = results.find((result) => result.code !== 0);

    if (failedResult) {
      return {
        available: false,
        error: failedResult.stderr.trim() || "disk helper failed",
        stats: new Map()
      };
    }

    const stats = new Map();
    for (const result of results) {
      for (const [pid, processStats] of parseProcStatsOutput(result.stdout)) {
        stats.set(pid, processStats);
      }
    }

    return {
      available: true,
      error: "",
      stats
    };
  }
}

function sumCounters(counters) {
  let readBytes = 0;
  let writeBytes = 0;

  for (const value of counters.values()) {
    readBytes += value.readBytes;
    writeBytes += value.writeBytes;
  }

  return {
    readBytes,
    writeBytes
  };
}

function counterDelta(current, previous) {
  if (!Number.isFinite(current) || current < 0) {
    return 0;
  }

  if (!Number.isFinite(previous) || current < previous) {
    return current;
  }

  return current - previous;
}

function optionValue(options, name, fallback) {
  return Object.prototype.hasOwnProperty.call(options, name)
    ? options[name]
    : fallback;
}

function appendLimited(previous, chunk, limit) {
  return `${previous}${chunk}`.trim().slice(-limit);
}
