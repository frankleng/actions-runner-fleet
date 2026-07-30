import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRunnerStatsReport,
  DEFAULT_STATS_SAMPLE_INTERVAL_MS,
  parseStatsSampleInterval,
  renderRunnerStatsMarkdown
} from "../lib/runnerctl-stats.mjs";

test("stats sampling interval accepts zero and safe intervals", () => {
  assert.equal(parseStatsSampleInterval(undefined), DEFAULT_STATS_SAMPLE_INTERVAL_MS);
  assert.equal(parseStatsSampleInterval("0"), 0);
  assert.equal(parseStatsSampleInterval("2000"), 2000);
  assert.equal(parseStatsSampleInterval("999"), DEFAULT_STATS_SAMPLE_INTERVAL_MS);
  assert.equal(parseStatsSampleInterval("fast"), DEFAULT_STATS_SAMPLE_INTERVAL_MS);
});

test("runner stats report preserves raw resource values for JSON output", () => {
  const report = buildRunnerStatsReport([
    {
      name: "mac|runner-1",
      serviceState: "running",
      repository: "https://github.com/example/project",
      metrics: {
        available: true,
        cpuPercent: 125.4,
        memoryBytes: 1572864,
        processCount: 3,
        uptimeSeconds: 93784,
        diskAvailable: true,
        diskReadBytesPerSecond: 1024,
        diskWriteBytesPerSecond: 2048,
        diskReadBytes: 4096,
        diskWriteBytes: 8192,
        networkAvailable: true,
        networkStatus: "ready",
        networkReceiveBytesPerSecond: 512,
        networkSendBytesPerSecond: 256,
        networkReceiveBytes: 16384,
        networkSendBytes: 32768
      }
    }
  ], {
    generatedAt: "2026-07-29T12:00:00.000Z",
    sampleWindowMs: 11000
  });

  assert.equal(report.generatedAt, "2026-07-29T12:00:00.000Z");
  assert.equal(report.sampleWindowMs, 11000);
  assert.equal(report.runners[0].metrics.cpuPercent, 125.4);
  assert.equal(report.runners[0].metrics.disk.readBytes, 4096);
  assert.equal(report.runners[0].metrics.network.sendBytes, 32768);
});

test("Markdown stats output contains every requested resource as a table", () => {
  const report = buildRunnerStatsReport([
    {
      name: "mac|runner-1",
      serviceState: "running",
      metrics: {
        available: true,
        cpuPercent: 125.4,
        memoryBytes: 1572864,
        processCount: 3,
        uptimeSeconds: 93784,
        diskAvailable: true,
        diskReadBytesPerSecond: 1024,
        diskWriteBytesPerSecond: 2048,
        diskReadBytes: 4096,
        diskWriteBytes: 8192,
        networkAvailable: true,
        networkStatus: "ready",
        networkReceiveBytesPerSecond: 512,
        networkSendBytesPerSecond: 256,
        networkReceiveBytes: 16384,
        networkSendBytes: 32768
      }
    }
  ]);

  const table = renderRunnerStatsMarkdown(report);

  assert.match(table, /^\| Runner \| Status \| CPU \| Memory \| Procs \| Uptime \|/);
  assert.ok(table.includes("Disk read/s"));
  assert.ok(table.includes("Disk write total"));
  assert.ok(table.includes("Net in/s"));
  assert.ok(table.includes("Net sent"));
  assert.ok(table.includes("mac\\|runner-1"));
  assert.ok(table.includes("125%"));
  assert.ok(table.includes("1.5 MiB"));
  assert.ok(table.includes("1 KiB/s"));
  assert.ok(table.includes("32 KiB"));
  assert.ok(table.includes("1d 02h"));
});

test("idle runners report zero I/O without waiting for network sampling", () => {
  const report = buildRunnerStatsReport([
    {
      name: "mac-runner-idle",
      serviceState: "disabled",
      metrics: {
        available: true,
        cpuPercent: 0,
        memoryBytes: 0,
        processCount: 0,
        uptimeSeconds: null,
        diskAvailable: true,
        diskReadBytes: 0,
        diskWriteBytes: 0,
        networkAvailable: false,
        networkStatus: "starting"
      }
    }
  ]);

  const runner = report.runners[0];
  assert.equal(runner.metrics.network.available, true);
  assert.equal(runner.metrics.network.status, "idle");
  assert.equal(runner.metrics.network.receiveBytes, 0);
  assert.ok(renderRunnerStatsMarkdown(report).includes("0 B/s"));
});
