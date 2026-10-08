import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { bySeverity, findingKey, findingsMarker, keysInMarker, rescanScript, type Finding } from "../src/tasks/semgrep.ts";

const repo = mkdtempSync(join(tmpdir(), "claude-autofix-semgrep-"));
after(() => rmSync(repo, { recursive: true, force: true }));

const finding = (path: string, line: number, severity = "WARNING", check_id = "rule.eval"): Finding => ({ check_id, path, start: { line }, end: { line }, extra: { message: "", severity } });

test("a finding keeps its key when unrelated edits move it to another line", () => {
  writeFileSync(join(repo, "a.js"), "eval(input)\n");
  const before = findingKey(finding("a.js", 1), repo);
  writeFileSync(join(repo, "a.js"), "const x = 1\n\n  eval(input)\n");
  assert.equal(findingKey(finding("a.js", 3), repo), before);
});

test("a finding gets a new key when the flagged code changes", () => {
  writeFileSync(join(repo, "b.js"), "eval(input)\n");
  const before = findingKey(finding("b.js", 1), repo);
  writeFileSync(join(repo, "b.js"), "eval(otherInput)\n");
  assert.notEqual(findingKey(finding("b.js", 1), repo), before);
});

test("markers round-trip the keys of a pull request", () => {
  const body = `Some description\n\n${findingsMarker(["aaaaaaaaaaaa", "bbbbbbbbbbbb"])}`;
  assert.deepEqual(keysInMarker(body), ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  assert.deepEqual(keysInMarker("no marker here"), []);
});

test("the most severe findings are triaged first", () => {
  const sorted = [finding("z.js", 1, "INFO"), finding("y.js", 1, "ERROR"), finding("x.js", 1, "WARNING")].sort(bySeverity);
  assert.deepEqual(sorted.map((f) => f.extra.severity), ["ERROR", "WARNING", "INFO"]);
});

test("the rescan script quotes configs and skips the scratch files", () => {
  const script = rescanScript({ configs: ["p/default", "rules/it's mine.yml"], excludeRules: ["yaml.github-actions.security.github-actions-mutable-action-tag.github-actions-mutable-action-tag"] });
  assert.match(script.body, /'--config' 'p\/default'/);
  assert.ok(script.body.includes(`'rules/it'\\''s mine.yml'`));
  assert.match(script.body, /'--exclude' 'semgrep-results\.json'/);
  assert.match(script.body, /'--exclude-rule' 'yaml\.github-actions\.security\.github-actions-mutable-action-tag/);
});
