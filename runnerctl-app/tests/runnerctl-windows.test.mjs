import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { controllerService } from "../lib/runnerctl-autoscale-service.mjs";
import { effectiveQuota } from "../lib/runnerctl-autoscale.mjs";
import { defaultRunnerDirectory, parseServicePid, parseServiceStatusOutput } from "../lib/runnerctl-core.mjs";
import { findRunnerProcessIds, parseWindowsProcessList } from "../lib/runnerctl-metrics.mjs";
import { filePrivate, scriptCommand, windowsLoadPerCpu } from "../lib/runnerctl-platform.mjs";

test("kit shell scripts run through Windows PowerShell only on Windows", () => {
  const env = { SystemRoot: "C:\\Windows" };
  assert.deepEqual(scriptCommand("./svc.sh", ["status"], "linux", env), { file: "./svc.sh", args: ["status"] });
  const windows = scriptCommand("C:\\kit\\manage-runners.sh", ["list"], "win32", env);
  assert.equal(windows.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(windows.args.slice(-3), ["-File", "C:\\kit\\manage-runners.ps1", "list"]);
  assert.ok(windows.args.includes("-NonInteractive"));
  // Non-script programs are never rewritten.
  assert.deepEqual(scriptCommand("systemctl", ["--user"], "win32", env), { file: "systemctl", args: ["--user"] });
});

test("Windows svc.ps1 status output parses like the systemd status", () => {
  const running = [
    "status actions.runner.titledock.ci-ephemeral-1:", "", "CPU limit: 600%", "",
    "\\actions-runner-fleet\\actions.runner.titledock.ci-ephemeral-1", "",
    "Live CPU quota: 600 100", "Started:", "4242 0 actions.runner.titledock.ci-ephemeral-1", ""
  ].join("\r\n");
  assert.equal(parseServiceStatusOutput(running), "running");
  assert.equal(parseServicePid(running, "actions.runner.titledock.ci-ephemeral-1"), 4242);
  assert.equal(effectiveQuota(running, 600), 600);
  assert.ok(Number.isNaN(effectiveQuota(running.replace("600 100", "600.04 100"), 600)));
  assert.equal(parseServiceStatusOutput("status x:\r\n\r\nCPU limit: 50%\r\n\r\nnot installed\r\n"), "not-installed");
  assert.equal(parseServiceStatusOutput("status x:\r\n\r\n\\actions-runner-fleet\\x\r\n\r\nStopped\r\n"), "stopped");
});

test("Windows process rows map lifetime CPU, memory, and I/O counters", () => {
  const output = [
    "100\t4\t30\t104857600\t60\t638650000000000000\t2048\t4096\tpowershell.exe -File C:\\kit\\.runners\\ci-1\\runsvc.ps1",
    "101\t100\t6\t52428800\t60\t638650000000000001\t10\t20\tC:\\kit\\.runners\\ci-1\\bin\\Runner.Listener.exe run",
    "102\t101\t0\t1024\t0\t638650000000000002\t0\t0\tcmd.exe /c echo\ttab",
    "bad row"
  ].join("\r\n");
  const { processes, stats } = parseWindowsProcessList(output);
  assert.equal(processes.length, 3);
  assert.equal(processes[0].cpuPercent, 50);
  assert.equal(processes[0].residentBytes, 104857600);
  assert.equal(processes[2].cpuPercent, 0);
  assert.equal(processes[2].command, "cmd.exe /c echo\ttab");
  assert.deepEqual(stats.get(100), { pid: 100, startToken: "638650000000000000", residentBytes: 104857600,
    physicalFootprintBytes: 104857600, diskReadBytes: 2048, diskWriteBytes: 4096 });

  // Directory matching is case-insensitive and separator-agnostic on Windows.
  const ids = findRunnerProcessIds({ directory: "c:/KIT/.runners/ci-1" }, processes);
  assert.deepEqual([...ids].sort(), [100, 101, 102]);
  assert.equal(findRunnerProcessIds({ directory: "C:\\kit\\.runners\\ci-10" }, processes).size, 0);
});

test("Windows default runner directories use backslashes", () => {
  assert.equal(defaultRunnerDirectory("C:\\kit", "ci 1", "win32"), "C:\\kit\\.runners\\ci-1");
  assert.equal(defaultRunnerDirectory("/kit", "ci 1", "linux"), "/kit/.runners/ci-1");
});

test("Windows controller runs from a logon task through kit-task.ps1", () => {
  const unit = controllerService({ root: "C:\\kit", configPath: "C:\\kit\\autoscale.json", node: "C:\\node\\node.exe", platform: "win32" });
  assert.match(unit.name, /^runnerctl-autoscale-[0-9a-f]{12}$/);
  assert.equal(unit.task.at(-1).replaceAll("/", "\\"), "C:\\kit\\kit-task.ps1");
  assert.deepEqual(unit.install.slice(0, 5), ["install", "-Name", unit.name, "-Trigger", "Logon"]);
  const encoded = unit.install[unit.install.indexOf("-CommandLine") + 1];
  assert.match(encoded, /^[A-Za-z0-9+/=]+$/);
  const argv = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.equal(argv[0], "C:\\node\\node.exe");
  assert.deepEqual(argv.slice(-4), ["--config", "C:\\kit\\autoscale.json", "--watch", "--apply"]);
  assert.deepEqual(unit.remove, ["remove", "-Name", unit.name]);
});

test("Windows private files must exclude every other local account", { skip: process.platform !== "win32" }, async () => {
  const kitDirectory = await mkdtemp(path.join(tmpdir(), "runnerctl-acl-"));
  try {
    const open = path.join(kitDirectory, "open.txt");
    const restricted = path.join(kitDirectory, "restricted.txt");
    await writeFile(open, "x");
    await writeFile(restricted, "x");
    const sid = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).trim().split(",").at(-1).replaceAll('"', "");
    execFileSync("icacls", [restricted, "/inheritance:r", "/grant:r", `*${sid}:F`, "*S-1-5-18:F"], { stdio: "ignore" });
    // Authenticated Users (S-1-5-11) is what a checkout under C:\ inherits.
    execFileSync("icacls", [open, "/inheritance:r", "/grant:r", `*${sid}:F`, "*S-1-5-11:R"], { stdio: "ignore" });
    assert.equal(await filePrivate(open, await stat(open)), false);
    assert.equal(await filePrivate(restricted, await stat(restricted)), true);
    assert.equal(await filePrivate(kitDirectory, await stat(kitDirectory)), false);
  } finally {
    await rm(kitDirectory, { recursive: true, force: true });
  }
});

test("Windows load is the busy CPU fraction between polls", () => {
  const cpu = (busy, idle) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });
  windowsLoadPerCpu([cpu(100, 100), cpu(100, 100)]);
  assert.equal(windowsLoadPerCpu([cpu(200, 100), cpu(150, 150)]), 0.75);
  assert.equal(windowsLoadPerCpu([cpu(200, 100), cpu(150, 150)]), 0);
});
