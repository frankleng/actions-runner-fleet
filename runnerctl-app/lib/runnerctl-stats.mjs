import {
  formatBytes,
  formatCpuPercent,
  formatDuration,
  formatRate
} from "./runnerctl-metrics.mjs";

export const DEFAULT_STATS_SAMPLE_INTERVAL_MS = 5500;

const TABLE_HEADERS = [
  "Runner",
  "Status",
  "CPU",
  "Memory",
  "Procs",
  "Uptime",
  "Disk read/s",
  "Disk write/s",
  "Disk read total",
  "Disk write total",
  "Net in/s",
  "Net out/s",
  "Net received",
  "Net sent"
];

export function parseStatsSampleInterval(
  value,
  fallback = DEFAULT_STATS_SAMPLE_INTERVAL_MS
) {
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

export function buildRunnerStatsReport(
  runners,
  {
    generatedAt = new Date(),
    sampleWindowMs = 0
  } = {}
) {
  return {
    generatedAt: new Date(generatedAt).toISOString(),
    sampleWindowMs,
    runners: runners.map((runner) => normalizeRunnerStats(runner))
  };
}

export function renderRunnerStatsMarkdown(report) {
  const lines = [
    `| ${TABLE_HEADERS.join(" | ")} |`,
    `| ${TABLE_HEADERS.map(() => "---").join(" | ")} |`
  ];

  for (const runner of report.runners) {
    const metrics = runner.metrics;
    const disk = metrics.disk;
    const network = metrics.network;
    const values = [
      runner.name,
      runner.status,
      metrics.available ? formatCpuPercent(metrics.cpuPercent) : "—",
      metrics.available ? formatBytes(metrics.memoryBytes) : "—",
      metrics.available ? metrics.processCount : "—",
      metrics.available ? formatDuration(metrics.uptimeSeconds) : "—",
      formatIoValue(disk.available, disk.readBytesPerSecond, formatRate),
      formatIoValue(disk.available, disk.writeBytesPerSecond, formatRate),
      formatIoValue(disk.available, disk.readBytes, formatBytes),
      formatIoValue(disk.available, disk.writeBytes, formatBytes),
      formatIoValue(
        network.available,
        network.receiveBytesPerSecond,
        formatRate,
        network.status
      ),
      formatIoValue(
        network.available,
        network.sendBytesPerSecond,
        formatRate,
        network.status
      ),
      formatIoValue(
        network.available,
        network.receiveBytes,
        formatBytes,
        network.status
      ),
      formatIoValue(
        network.available,
        network.sendBytes,
        formatBytes,
        network.status
      )
    ];

    lines.push(`| ${values.map(escapeMarkdownCell).join(" | ")} |`);
  }

  return lines.join("\n");
}

function normalizeRunnerStats(runner) {
  const metrics = runner.metrics ?? {};
  const metricsAvailable = metrics.available === true;
  const processCount = numberOrNull(metrics.processCount);
  const idle = metricsAvailable && processCount === 0;
  const diskAvailable = metricsAvailable && (metrics.diskAvailable === true || idle);
  const networkAvailable =
    metricsAvailable && (metrics.networkAvailable === true || idle);

  return {
    name: String(runner.name ?? ""),
    status: String(runner.serviceState ?? "error"),
    repository: String(runner.repository ?? "-"),
    metrics: {
      available: metricsAvailable,
      error: String(metrics.error ?? ""),
      cpuPercent: numberOrNull(metrics.cpuPercent),
      memoryBytes: numberOrNull(metrics.memoryBytes),
      processCount,
      uptimeSeconds: numberOrNull(metrics.uptimeSeconds),
      disk: {
        available: diskAvailable,
        error: String(metrics.diskError ?? ""),
        readBytesPerSecond: idle
          ? 0
          : numberOrNull(metrics.diskReadBytesPerSecond),
        writeBytesPerSecond: idle
          ? 0
          : numberOrNull(metrics.diskWriteBytesPerSecond),
        readBytes: idle ? 0 : numberOrNull(metrics.diskReadBytes),
        writeBytes: idle ? 0 : numberOrNull(metrics.diskWriteBytes)
      },
      network: {
        available: networkAvailable,
        status: idle ? "idle" : String(metrics.networkStatus ?? "unavailable"),
        error: String(metrics.networkError ?? ""),
        receiveBytesPerSecond: idle
          ? 0
          : numberOrNull(metrics.networkReceiveBytesPerSecond),
        sendBytesPerSecond: idle
          ? 0
          : numberOrNull(metrics.networkSendBytesPerSecond),
        receiveBytes: idle ? 0 : numberOrNull(metrics.networkReceiveBytes),
        sendBytes: idle ? 0 : numberOrNull(metrics.networkSendBytes)
      }
    }
  };
}

function numberOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function formatIoValue(available, value, formatter, status = "") {
  if (available) {
    return formatter(value);
  }

  return status === "starting" ? "sampling" : "—";
}

function escapeMarkdownCell(value) {
  return String(value ?? "—")
    .replace(/\r?\n/g, " ")
    .replaceAll("|", "\\|");
}
