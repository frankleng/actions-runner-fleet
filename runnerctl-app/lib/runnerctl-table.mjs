import { presentServiceState } from "./runnerctl-core.mjs";
import {
  formatBytes,
  formatCpuPercent,
  formatDuration
} from "./runnerctl-metrics.mjs";

const COLUMN_WIDTHS = {
  runner: 18,
  status: 8,
  cpu: 6,
  memory: 5,
  ioPair: 11,
  uptime: 8
};

// Blessed renders border labels one cell to the right of list item content.
// Indenting each item keeps the header and row columns on the same cells.
export const RUNNER_TABLE_ITEM_INDENT = " ";

export function formatRunnerTableHeader() {
  return [
    padRight("RUNNER", COLUMN_WIDTHS.runner),
    padRight("STATUS", COLUMN_WIDTHS.status),
    padLeft("CPU", COLUMN_WIDTHS.cpu),
    padLeft("MEM", COLUMN_WIDTHS.memory),
    center("D:R/W/s", COLUMN_WIDTHS.ioPair),
    padLeft("N:IN/OUT/s", COLUMN_WIDTHS.ioPair),
    padLeft("UP", COLUMN_WIDTHS.uptime)
  ].join(" ");
}

export function formatRunnerTableRow(runner) {
  const service = presentServiceState(runner.serviceState);
  const metrics = runner.metrics ?? {};
  const name = padRight(shorten(runner.name, COLUMN_WIDTHS.runner), COLUMN_WIDTHS.runner);
  const status = padRight(compactServiceLabel(service.label), COLUMN_WIDTHS.status);
  const cpu = padLeft(formatCpuPercent(metrics.cpuPercent), COLUMN_WIDTHS.cpu);
  const memory = padLeft(
    formatBytes(metrics.memoryBytes, { compact: true }),
    COLUMN_WIDTHS.memory
  );
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
    shorten(formatDuration(metrics.uptimeSeconds).replaceAll(" ", ""), COLUMN_WIDTHS.uptime),
    COLUMN_WIDTHS.uptime
  );

  return (
    `${RUNNER_TABLE_ITEM_INDENT}${name} {${service.color}-fg}${status}` +
    `{/${service.color}-fg} ${cpu} ${memory} ` +
    `${diskRead}/${diskWrite} ${networkReceive}/${networkSend} ${uptime}`
  );
}

function compactServiceLabel(serviceLabel) {
  return serviceLabel === "not-installed" ? "no-svc" : serviceLabel;
}

function shorten(value, limit) {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 1)}…`;
}

function center(value, width) {
  const remaining = Math.max(0, width - value.length);
  const left = Math.floor(remaining / 2);
  return `${" ".repeat(left)}${value}${" ".repeat(remaining - left)}`;
}

function padRight(value, width) {
  return value.length >= width ? value : value.padEnd(width, " ");
}

function padLeft(value, width) {
  return value.length >= width ? value : value.padStart(width, " ");
}
