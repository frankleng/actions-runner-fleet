import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceCumulativeCounters,
  aggregateRunnerProcesses,
  buildRunnerMetricLines,
  collectDescendantProcessIds,
  findRunnerProcessIds,
  formatBytes,
  formatCpuPercent,
  formatDuration,
  formatRate,
  parseElapsedSeconds,
  parseNettopRecord,
  parseProcessList,
  parseProcStatsOutput
} from "../lib/runnerctl-metrics.mjs";

test("elapsed process time accepts ps duration formats", () => {
  assert.equal(parseElapsedSeconds("02:03"), 123);
  assert.equal(parseElapsedSeconds("01:02:03"), 3723);
  assert.equal(parseElapsedSeconds("2-03:04:05"), 183845);
  assert.equal(parseElapsedSeconds("not-a-duration"), null);
});

test("process rows are parsed and runner ownership follows the full descendant tree", () => {
  const processes = parseProcessList([
    " 100 1 12.5 2048 01:02 /Users/example/actions-runner-one/runsvc.sh",
    " 101 100 3.5 4096 01:01 /Users/example/actions-runner-one/bin/Runner.Listener run",
    " 102 101 20.0 8192 00:30 /bin/zsh ./job.sh",
    " 200 1 1.0 1024 00:45 /Users/example/actions-runner-one-more/runsvc.sh"
  ].join("\n"));

  assert.equal(processes.length, 4);
  assert.equal(processes[0].residentBytes, 2 * 1024 * 1024);
  assert.deepEqual(
    [...collectDescendantProcessIds(new Set([100]), processes)].sort(),
    [100, 101, 102]
  );
  assert.deepEqual(
    [...findRunnerProcessIds({
      directory: "/Users/example/actions-runner-one",
      servicePid: 100
    }, processes)].sort(),
    [100, 101, 102]
  );
});

test("native disk and nettop counters parse by PID and aggregate for a runner", () => {
  const processes = parseProcessList([
    " 100 1 12.5 2048 01:02 /runner/runsvc.sh",
    " 101 100 3.5 4096 01:01 /runner/bin/Runner.Listener run"
  ].join("\n"));
  const procStats = parseProcStatsOutput([
    "100\t111\t2097152\t1048576\t1000\t2000",
    "101\t222\t4194304\t3145728\t3000\t4000"
  ].join("\n"));
  const networkRecord = parseNettopRecord("Runner.Listener.101,5000,6000,");

  assert.deepEqual(networkRecord, {
    pid: 101,
    receivedBytes: 5000,
    sentBytes: 6000
  });

  const aggregate = aggregateRunnerProcesses(
    new Set([100, 101]),
    processes,
    procStats,
    new Map([[101, networkRecord]])
  );

  assert.equal(aggregate.cpuPercent, 16);
  assert.equal(aggregate.memoryBytes, 6 * 1024 * 1024);
  assert.equal(aggregate.processCount, 2);
  assert.equal(aggregate.uptimeSeconds, 62);
  assert.deepEqual(aggregate.diskCounters.get("100:111"), {
    readBytes: 1000,
    writeBytes: 2000
  });
  assert.deepEqual(aggregate.networkCounters.get("101"), {
    readBytes: 5000,
    writeBytes: 6000
  });
});

test("cumulative counters retain exited processes and calculate per-second rates", () => {
  const first = advanceCumulativeCounters(
    null,
    new Map([["100:start", { readBytes: 100, writeBytes: 50 }]]),
    1000
  );

  assert.equal(first.totalReadBytes, 100);
  assert.equal(first.totalWriteBytes, 50);
  assert.equal(first.readBytesPerSecond, 0);

  const second = advanceCumulativeCounters(
    first,
    new Map([
      ["100:start", { readBytes: 150, writeBytes: 70 }],
      ["101:start", { readBytes: 20, writeBytes: 10 }]
    ]),
    3000
  );

  assert.equal(second.totalReadBytes, 170);
  assert.equal(second.totalWriteBytes, 80);
  assert.equal(second.readBytesPerSecond, 35);
  assert.equal(second.writeBytesPerSecond, 15);

  const afterExit = advanceCumulativeCounters(second, new Map(), 4000);
  assert.equal(afterExit.totalReadBytes, 170);
  assert.equal(afterExit.totalWriteBytes, 80);
  assert.equal(afterExit.readBytesPerSecond, 0);
  assert.equal(afterExit.writeBytesPerSecond, 0);
});

test("metric values use compact table units and readable detail units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1 KiB");
  assert.equal(formatBytes(1536, { compact: true }), "1.5K");
  assert.equal(formatRate(1024), "1 KiB/s");
  assert.equal(formatCpuPercent(4.25), "4.3%");
  assert.equal(formatCpuPercent(125.4), "125%");
  assert.equal(formatDuration(93784), "1d 02h");
});

test("runner detail metrics include live resources, rates, and totals", () => {
  const lines = buildRunnerMetricLines({
    available: true,
    cpuPercent: 12.5,
    memoryBytes: 1024 * 1024,
    processCount: 3,
    uptimeSeconds: 90,
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
  });

  assert.ok(lines.some((line) => line.includes("{blue-fg}CPU{/blue-fg} 13%")));
  assert.ok(lines.some((line) => line.includes("{blue-fg}Disk/s{/blue-fg}")));
  assert.ok(lines.some((line) => line.includes("{blue-fg}Net total{/blue-fg}")));
  assert.ok(lines.some((line) => line.includes("In 16 KiB")));
});
