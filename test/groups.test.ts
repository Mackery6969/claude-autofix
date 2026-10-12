import assert from "node:assert/strict";
import { test } from "node:test";
import type { Alert } from "../src/tasks/alerts.ts";
import { applyGrouping, byPriority, groupByRule, groupingPrompt, pinGroup } from "../src/tasks/groups.ts";
import type { IssueWork } from "../src/tasks/issues.ts";

const alert = (number: number, rule: string, path = "src/a.ts", security = false): Alert => ({
  number,
  tool: "CodeQL",
  rule,
  description: "",
  severity: security ? "high" : "warning",
  securityLevel: security ? "high" : null,
  level: "warning",
  security,
  path,
  startLine: number,
  endLine: number,
  message: `message ${number}`,
  url: "",
});

const issue = (number: number, title: string): IssueWork => ({ number, title, body: "Flesh blobs don't animate | at all", url: "", author: "someone", labels: ["bug"], rank: 4 });

test("the grouping prompt lists every item by id, one line each", () => {
  const prompt = groupingPrompt([alert(12, "js/xss")], [issue(32, "Flesh mobs lack a walking animation")], 10);
  assert.match(prompt, /^alert-12 \| CodeQL \| js\/xss \| src\/a\.ts:12 \| message 12$/m);
  assert.match(prompt, /^issue-32 \| labels: bug \| Flesh mobs lack a walking animation \| Flesh blobs don't animate \/ at all$/m);
  assert.match(prompt, /at most 10 items/);
});

test("Claude's groups are used, related issues land together", () => {
  const alerts = [alert(1, "js/xss", "a.ts", true), alert(2, "js/xss", "b.ts", true)];
  const issues = [issue(32, "Flesh mobs lack a walking animation"), issue(40, "Flesh blob legs don't move")];
  const reply = 'Here you go: {"groups": [{"title": "Escape HTML output", "items": ["alert-1", "alert-2"]}, {"title": "Flesh blob animation", "items": ["issue-32", "issue-40"]}]}';
  const groups = applyGrouping(reply, alerts, issues, 10);
  assert.deepEqual(groups?.map((group) => [group.label, group.alerts.map((a) => a.number), group.issues.map((i) => i.number)]), [
    ["Escape HTML output", [1, 2], []],
    ["Flesh blob animation", [], [32, 40]],
  ]);
});

test("unknown ids are ignored, duplicates count once, and anything left out gets its own group", () => {
  const alerts = [alert(1, "js/xss"), alert(2, "js/sql")];
  const groups = applyGrouping('{"groups": [{"title": "One", "items": ["alert-1", "alert-99", "alert-1"]}, {"title": "Again", "items": ["alert-1"]}]}', alerts, [issue(32, "x")], 10);
  assert.deepEqual(groups?.map((group) => [group.label, group.alerts.length + group.issues.length]), [
    ["One", 1],
    ["js/sql", 1],
    ["issue #32", 1],
  ]);
});

test("oversized groups are split to the size limit", () => {
  const alerts = [1, 2, 3, 4, 5].map((n) => alert(n, "gml/string-char-at-loop"));
  const groups = applyGrouping(`{"groups": [{"title": "Quadratic loops", "items": ${JSON.stringify(alerts.map((a) => `alert-${a.number}`))}}]}`, alerts, [], 2);
  assert.deepEqual(groups?.map((group) => group.alerts.length), [2, 2, 1]);
});

test("an unreadable reply falls back to the caller", () => {
  assert.equal(applyGrouping("I couldn't decide.", [alert(1, "js/xss")], [], 10), undefined);
  assert.equal(applyGrouping('{"groups": "nope"}', [alert(1, "js/xss")], [], 10), undefined);
});

test("the fallback groups alerts by rule and gives each issue its own pull request", () => {
  const groups = groupByRule([alert(1, "js/xss", "b.ts"), alert(2, "js/sql"), alert(3, "js/xss", "a.ts")], [issue(32, "x"), issue(40, "y")], 10);
  assert.deepEqual(groups.map((group) => [group.alerts.map((a) => a.number), group.issues.map((i) => i.number)]), [
    [[3, 1], []],
    [[2], []],
    [[], [32]],
    [[], [40]],
  ]);
});

test("unpinned actions get their own group, and security work is ordered first", () => {
  const pins = pinGroup([alert(1, "actions/unpinned-tag", ".github/workflows/ci.yml", true), alert(2, "js/xss")]);
  assert.deepEqual(pins.map((group) => group.alerts.map((a) => a.number)), [[1]]);
  const ordered = byPriority([...groupByRule([], [issue(32, "x")], 10), ...groupByRule([alert(5, "js/xss", "a.ts", true)], [], 10)]);
  assert.deepEqual(ordered.map((group) => group.label), ["js/xss (1 alert)", "issue #32: x"]);
});
