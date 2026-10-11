import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { CodeScanningAlert } from "../src/base/github.ts";
import { alertRank, DISMISSALS_FILE, fromOtherScanners, parseScannerFilter, readDismissals } from "../src/tasks/alerts.ts";

const repo = mkdtempSync(join(tmpdir(), "claude-autofix-alerts-"));
after(() => rmSync(repo, { recursive: true, force: true }));

const alert = (number: number, tool: string, overrides: Partial<CodeScanningAlert["rule"]> = {}): CodeScanningAlert => ({
  number,
  html_url: `https://github.com/o/r/security/code-scanning/${number}`,
  rule: { id: "gml/rule", severity: "note", security_severity_level: null, description: "", tags: [], ...overrides },
  tool: { name: tool },
  most_recent_instance: { location: { path: "scripts/a.gml", start_line: 3, end_line: 3 }, message: { text: "message" } },
});

test("takes alerts from other scanners and leaves Semgrep's own uploads alone", () => {
  const alerts = [alert(1, "GML Code Scanner"), alert(2, "Semgrep OSS"), alert(3, "CodeQL")];
  assert.deepEqual(fromOtherScanners(alerts, parseScannerFilter("all")).map((a) => a.number), [1, 3]);
  assert.deepEqual(fromOtherScanners(alerts, parseScannerFilter("GML Code Scanner")).map((a) => a.number), [1]);
  assert.deepEqual(fromOtherScanners(alerts, parseScannerFilter("none")), []);
});

test("security alerts come first, then other issues by severity", () => {
  const ranked = fromOtherScanners(
    [
      alert(1, "GML Code Scanner", { severity: "note", tags: ["performance"] }),
      alert(2, "GML Code Scanner", { severity: "error", tags: ["correctness"] }),
      alert(3, "CodeQL", { severity: "warning", security_severity_level: "high", tags: ["security"] }),
      alert(4, "GML Code Scanner", { severity: "warning", tags: ["security"] }),
      alert(5, "CodeQL", { severity: "error", security_severity_level: "critical", tags: ["security"] }),
    ],
    parseScannerFilter("all"),
  ).sort((a, b) => alertRank(a) - alertRank(b));
  assert.deepEqual(ranked.map((a) => a.number), [5, 3, 4, 2, 1]);
  assert.deepEqual(ranked.map((a) => a.security), [true, true, true, false, false]);
});

test("only valid dismissals of alerts in this run are accepted", () => {
  writeFileSync(
    join(repo, DISMISSALS_FILE),
    JSON.stringify([
      { alert: 1, reason: "false positive", comment: "The value is a compile-time constant." },
      { alert: 2, reason: "Won't fix", comment: "Intentional for save compatibility." },
      { alert: 99, reason: "false positive", comment: "Not in this run." },
      { alert: 3, reason: "because", comment: "Unknown reason." },
      { alert: 4, reason: "used in tests", comment: "" },
    ]),
  );
  assert.deepEqual(readDismissals(repo, new Set([1, 2, 3, 4])), [
    { alert: 1, reason: "false positive", comment: "The value is a compile-time constant." },
    { alert: 2, reason: "won't fix", comment: "Intentional for save compatibility." },
  ]);
});

test("a dismissals file that isn't JSON dismisses nothing", () => {
  writeFileSync(join(repo, DISMISSALS_FILE), "not json");
  assert.deepEqual(readDismissals(repo, new Set([1])), []);
});
