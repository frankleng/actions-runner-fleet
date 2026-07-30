#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadTrackedRunners } from "../lib/runnerctl-core.mjs";
import { RunnerMetricsSampler } from "../lib/runnerctl-metrics.mjs";
import {
  buildRunnerStatsReport,
  parseStatsSampleInterval,
  renderRunnerStatsMarkdown
} from "../lib/runnerctl-stats.mjs";

const __filename = fileURLToPath(import.meta.url);
const APP_DIR = path.dirname(path.dirname(__filename));
const ROOT_DIR = path.dirname(APP_DIR);
const REGISTRY_PATH =
  process.env.RUNNER_REGISTRY_PATH ?? path.join(ROOT_DIR, "runners.tsv");
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("help")) {
  printHelp();
  process.exit(0);
}

const unknownArgs = args.filter((argument) => argument !== "--json");
if (unknownArgs.length > 0) {
  console.error(`runnerctl stats: unsupported option: ${unknownArgs[0]}`);
  console.error("Run './runnerctl stats --help' for usage.");
  process.exit(2);
}

const sampleIntervalMs = parseStatsSampleInterval(
  process.env.RUNNER_STATS_SAMPLE_MS
);
const metricsSampler = new RunnerMetricsSampler();

try {
  let sampledRunners = await sampleTrackedRunners();
  let sampleWindowMs = 0;
  const hasActiveProcesses = sampledRunners.some(
    (runner) => (runner.metrics?.processCount ?? 0) > 0
  );

  if (hasActiveProcesses && sampleIntervalMs > 0) {
    for (let sampleIndex = 0; sampleIndex < 2; sampleIndex += 1) {
      await delay(sampleIntervalMs);
      sampledRunners = await sampleTrackedRunners();
    }
    sampleWindowMs = sampleIntervalMs * 2;
  }

  const report = buildRunnerStatsReport(sampledRunners, { sampleWindowMs });
  const output = args.includes("--json")
    ? JSON.stringify(report, null, 2)
    : renderRunnerStatsMarkdown(report);

  process.stdout.write(`${output}\n`);
} catch (error) {
  console.error(`runnerctl stats failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  metricsSampler.close();
}

async function sampleTrackedRunners() {
  const trackedRunners = await loadTrackedRunners(REGISTRY_PATH);
  return metricsSampler.sample(trackedRunners);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function printHelp() {
  console.log(`runnerctl resource stats

Usage:
  ./runnerctl stats
  ./runnerctl stats --json

Output:
  Markdown table by default; --json returns raw numeric values.

Sampling:
  RUNNER_STATS_SAMPLE_MS defaults to 5500. Active runners use two intervals
  (about 11 seconds) so disk and network rate columns have two snapshots.
  Set it to 0 for an immediate snapshot; I/O rates may then be zero or sampling.
`);
}
