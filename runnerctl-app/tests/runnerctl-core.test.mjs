import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import blessed from "blessed";

import {
  buildRunnerActivityLines,
  buildRunnerDetailLines,
  buildRunnerServiceName,
  classifyGitHubRunnerTargetUrl,
  DEFAULT_GITHUB_RUNNER_SCOPE,
  parseRegistry,
  getActionDefinitions,
  getGitHubRunnerTargetUrlExample,
  getRunnerNavigationConfig,
  getRunnerSelectionEvents,
  buildManageRunnersArgs,
  defaultRunnerDirectory,
  getRunnerActionSequence,
  parseAutoRefreshInterval,
  parseLaunchctlDisabledOutput,
  parseServicePid,
  shouldCancelPromptOnKey,
  shouldAutoRefresh,
  moveSelectionIndex,
  normalizeGitHubRunnerScope,
  parseServiceStatusOutput,
  presentServiceState,
  shouldPreservePromptFocus
} from "../lib/runnerctl-core.mjs";

test("parseRegistry returns tracked runners from tab-delimited rows", () => {
  const rows = [
    "mac-runner-1\t/Users/example/actions-runner-mac-runner-1",
    "",
    "mac-runner-2\t/Users/example/actions-runner-mac-runner-2"
  ].join("\n");

  assert.deepEqual(parseRegistry(rows), [
    {
      name: "mac-runner-1",
      directory: "/Users/example/actions-runner-mac-runner-1"
    },
    {
      name: "mac-runner-2",
      directory: "/Users/example/actions-runner-mac-runner-2"
    }
  ]);
});

test("parseRegistry ignores malformed rows", () => {
  const rows = [
    "broken",
    "still-broken\t",
    "mac-runner-1\t/Users/example/actions-runner-mac-runner-1"
  ].join("\n");

  assert.deepEqual(parseRegistry(rows), [
    {
      name: "mac-runner-1",
      directory: "/Users/example/actions-runner-mac-runner-1"
    }
  ]);
});

test("getActionDefinitions returns dashboard actions", () => {
  const actions = getActionDefinitions();

  assert.deepEqual(actions.map((action) => action.key), [
    "n",
    "i",
    "s",
    "x",
    "r",
    "q"
  ]);
});

test("getRunnerSelectionEvents includes single-click selection updates", () => {
  assert.deepEqual(getRunnerSelectionEvents(), [
    "select item",
    "select"
  ]);
});

test("runner registration scope accepts clear names and common abbreviations", () => {
  assert.equal(DEFAULT_GITHUB_RUNNER_SCOPE, "organization");
  assert.equal(normalizeGitHubRunnerScope("repo"), "repository");
  assert.equal(normalizeGitHubRunnerScope("ORGANIZATION"), "organization");
  assert.equal(normalizeGitHubRunnerScope("3"), "enterprise");
  assert.equal(normalizeGitHubRunnerScope("account"), null);
});

test("runner target URLs distinguish repository, organization, and enterprise scopes", () => {
  assert.equal(
    classifyGitHubRunnerTargetUrl("https://github.com/example-user/example-repo"),
    "repository"
  );
  assert.equal(
    classifyGitHubRunnerTargetUrl("https://github.com/example-org/"),
    "organization"
  );
  assert.equal(
    classifyGitHubRunnerTargetUrl("https://github.com/enterprises/example-enterprise"),
    "enterprise"
  );
  assert.equal(
    classifyGitHubRunnerTargetUrl("https://github.com/example/too/many"),
    null
  );
  assert.equal(
    getGitHubRunnerTargetUrlExample("enterprise"),
    "https://github.com/enterprises/ENTERPRISE"
  );
});

test("runner navigation moves exactly one row for each arrow or vim keypress", (t) => {
  const config = getRunnerNavigationConfig();

  assert.equal(config.keys, false);
  assert.deepEqual(config.bindings, [
    { keys: ["up", "k"], delta: -1 },
    { keys: ["down", "j"], delta: 1 }
  ]);

  for (const key of ["up", "down", "k", "j"]) {
    assert.equal(
      config.bindings.filter((binding) => binding.keys.includes(key)).length,
      1
    );
  }

  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 80;
  output.rows = 24;

  const screen = blessed.screen({ input, output, terminal: "xterm" });
  t.after(() => screen.destroy());

  const list = blessed.list({
    parent: screen,
    keys: config.keys,
    items: ["one", "two", "three"]
  });
  let selectedIndex = 0;

  list.on("select item", () => {
    selectedIndex = list.selected;
  });

  for (const binding of config.bindings) {
    list.key(binding.keys, () => {
      selectedIndex = moveSelectionIndex(
        selectedIndex,
        list.items.length,
        binding.delta
      );
      list.select(selectedIndex);
    });
  }

  list.focus();

  const press = (name) => {
    screen.program.emit("keypress", null, { name, full: name });
  };

  press("down");
  assert.equal(list.selected, 1);
  press("j");
  assert.equal(list.selected, 2);
  press("up");
  assert.equal(list.selected, 1);
  press("k");
  assert.equal(list.selected, 0);
});

test("buildManageRunnersArgs routes scripted actions to the shell helper", () => {
  assert.deepEqual(buildManageRunnersArgs("register", {
    name: "mac-runner-1",
    token: "TOKEN",
    url: "https://github.com/example-org",
    directory: "/Users/example/actions-runner-mac-runner-1"
  }), [
    "register",
    "mac-runner-1",
    "TOKEN",
    "https://github.com/example-org",
    "/Users/example/actions-runner-mac-runner-1"
  ]);

  assert.deepEqual(buildManageRunnersArgs("start", { name: "mac-runner-1" }), [
    "start",
    "mac-runner-1"
  ]);
});

test("defaultRunnerDirectory derives the auto-created runner path from the current install", () => {
  assert.equal(
    defaultRunnerDirectory("/Users/example/actions-runner", "mac runner 1"),
    "/Users/example/actions-runner-mac-runner-1"
  );
});

test("moveSelectionIndex clamps arrow-key movement to the available rows", () => {
  assert.equal(moveSelectionIndex(0, 3, 1), 1);
  assert.equal(moveSelectionIndex(1, 3, 1), 2);
  assert.equal(moveSelectionIndex(2, 3, 1), 2);
  assert.equal(moveSelectionIndex(2, 3, -1), 1);
  assert.equal(moveSelectionIndex(0, 3, -1), 0);
  assert.equal(moveSelectionIndex(0, 0, 1), 0);
});

test("shouldPreservePromptFocus only releases blur when the modal is explicitly closing", () => {
  assert.equal(shouldPreservePromptFocus({ isClosing: false }), true);
  assert.equal(shouldPreservePromptFocus({ isClosing: true }), false);
});

test("shouldCancelPromptOnKey only cancels on escape", () => {
  assert.equal(shouldCancelPromptOnKey("escape"), true);
  assert.equal(shouldCancelPromptOnKey("enter"), false);
  assert.equal(shouldCancelPromptOnKey("down"), false);
});

test("parseServiceStatusOutput maps svc.sh status output to dashboard states", () => {
  assert.equal(
    parseServiceStatusOutput("status foo:\n\nStarted:\n123 0 foo\n"),
    "running"
  );
  assert.equal(
    parseServiceStatusOutput("status foo:\n\nStopped\n"),
    "stopped"
  );
  assert.equal(
    parseServiceStatusOutput("status foo:\n\nDisabled\n"),
    "disabled"
  );
  assert.equal(
    parseServiceStatusOutput("status foo:\n\nnot installed\n"),
    "not-installed"
  );
  assert.equal(
    parseServiceStatusOutput("Load failed: 5: Input/output error"),
    "error"
  );
});

test("presentServiceState returns display labels and colors for each state", () => {
  assert.deepEqual(presentServiceState("running"), {
    label: "running",
    color: "green"
  });
  assert.deepEqual(presentServiceState("stopped"), {
    label: "stopped",
    color: "red"
  });
  assert.deepEqual(presentServiceState("disabled"), {
    label: "disabled",
    color: "yellow"
  });
  assert.deepEqual(presentServiceState("not-installed"), {
    label: "not-installed",
    color: "gray"
  });
});

test("auto-refresh defaults to five seconds and can be tuned or disabled", () => {
  assert.equal(parseAutoRefreshInterval(undefined), 5000);
  assert.equal(parseAutoRefreshInterval("2000"), 2000);
  assert.equal(parseAutoRefreshInterval("0"), 0);
  assert.equal(parseAutoRefreshInterval("999"), 5000);
  assert.equal(parseAutoRefreshInterval("fast"), 5000);
});

test("auto-refresh waits while an action or input dialog is active", () => {
  assert.equal(shouldAutoRefresh({ busy: false, modalOpen: false }), true);
  assert.equal(shouldAutoRefresh({ busy: true, modalOpen: false }), false);
  assert.equal(shouldAutoRefresh({ busy: false, modalOpen: true }), false);
});

test("launchd disabled state is matched to the exact runner service", () => {
  const serviceName = buildRunnerServiceName(
    "https://github.com/example-org",
    "mac-runner-3"
  );

  assert.equal(serviceName, "actions.runner.example-org.mac-runner-3");
  assert.equal(
    parseLaunchctlDisabledOutput(
      [
        "disabled services = {",
        '  "actions.runner.example-org.mac-runner-3" => disabled',
        "}"
      ].join("\n"),
      serviceName
    ),
    true
  );
  assert.equal(
    parseLaunchctlDisabledOutput(
      '  "actions.runner.example-org.mac-runner-30" => disabled',
      serviceName
    ),
    false
  );
});

test("service PID is read from the exact launchctl status row", () => {
  const output = [
    "status actions.runner.example-org.mac-runner-3:",
    "",
    "Started:",
    "12345 0 actions.runner.example-org.mac-runner-3",
    ""
  ].join("\n");

  assert.equal(
    parseServicePid(output, "actions.runner.example-org.mac-runner-3"),
    12345
  );
  assert.equal(
    parseServicePid(output, "actions.runner.example-org.mac-runner-30"),
    null
  );
  assert.equal(parseServicePid("Stopped", "actions.runner.example-org.mac-runner-3"), null);
});

test("getRunnerActionSequence auto-installs service before start when missing", () => {
  assert.deepEqual(
    getRunnerActionSequence("start", { serviceState: "not-installed" }),
    ["install-service", "start"]
  );
  assert.deepEqual(
    getRunnerActionSequence("start", { serviceState: "stopped" }),
    ["start"]
  );
  assert.deepEqual(
    getRunnerActionSequence("status", { serviceState: "running" }),
    ["status"]
  );
});

test("buildRunnerDetailLines puts the runner status at the top of the detail pane", () => {
  const lines = buildRunnerDetailLines({
    name: "mac-runner-1",
    directory: "/Users/example/actions-runner-mac-runner-1",
    configured: true,
    serviceInstalled: true,
    serviceState: "running",
    workFolder: "_work",
    repository: "https://github.com/example-org"
  });

  assert.equal(lines[0], "{bold}mac-runner-1{/bold}");
  assert.match(lines[1], /Status/);
  assert.match(lines[1], /running/);

  const linesWithMetrics = buildRunnerDetailLines(
    {
      name: "mac-runner-1",
      directory: "/Users/example/actions-runner-mac-runner-1",
      configured: true,
      serviceInstalled: true,
      serviceState: "running",
      workFolder: "_work",
      repository: "https://github.com/example-org"
    },
    ["Runner metric line"]
  );
  assert.ok(linesWithMetrics.indexOf("Runner metric line") < linesWithMetrics.indexOf(
    "{blue-fg}Directory{/blue-fg}"
  ));
});

test("buildRunnerActivityLines shows selected runner status output in the activity pane", () => {
  const lines = buildRunnerActivityLines({
    name: "mac-runner-1",
    serviceState: "running",
    serviceStatusOutput: "status runner:\n\nStarted:\n123 0 runner\n"
  });

  assert.equal(lines[0], "Selected runner: mac-runner-1");
  assert.match(lines[1], /Current status: running/);
  assert.match(lines[3], /status runner:/);
  assert.match(lines[4], /Started:/);
});
