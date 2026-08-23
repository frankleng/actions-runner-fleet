import test from "node:test";
import assert from "node:assert/strict";

import {
  formatRunnerTableHeader,
  formatRunnerTableRow,
  RUNNER_TABLE_ITEM_INDENT
} from "../lib/runnerctl-table.mjs";

test("dashboard headers align with the fixed-width runner columns", () => {
  const header = `${RUNNER_TABLE_ITEM_INDENT}${formatRunnerTableHeader()}`;
  const row = stripTags(formatRunnerTableRow({
    name: "littlebeat-ubuntu-1",
    serviceState: "running",
    metrics: {
      cpuPercent: 131,
      memoryBytes: 9.34 * 1024 ** 3,
      diskReadBytesPerSecond: null,
      diskWriteBytesPerSecond: null,
      networkReceiveBytesPerSecond: null,
      networkSendBytesPerSecond: null,
      uptimeSeconds: 90000
    }
  }));

  assert.equal(header.length, row.length);
  assert.equal(header.indexOf("STATUS"), row.indexOf("running"));
  assert.equal(endOf(header, "CPU"), endOf(row, "131%"));
  assert.equal(endOf(header, "MEM"), endOf(row, "9.34G"));
  assert.equal(header.indexOf("D:R/W/s") + 3, row.indexOf("—/") + 1);
  assert.equal(header.indexOf("N:IN/OUT/s") + 4, row.lastIndexOf("—/") + 1);
  assert.equal(endOf(header, "UP"), endOf(row, "1d01h"));
});

function stripTags(value) {
  return value.replace(/\{\/?[^}]+\}/g, "");
}

function endOf(value, token) {
  return value.indexOf(token) + token.length;
}
