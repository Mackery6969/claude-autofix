import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Issue } from "../src/base/github.ts";
import { actionableIssues, DEFAULT_ISSUE_LABELS, issueRank, issuesSection, OUTCOMES_FILE, readOutcomes } from "../src/tasks/issues.ts";
import { handledMarker, keysInMarker } from "../src/tasks/markers.ts";

const repo = mkdtempSync(join(tmpdir(), "claude-autofix-issues-"));
after(() => rmSync(repo, { recursive: true, force: true }));

const issue = (number: number, labels: string[]): Issue => ({ number, title: `Issue ${number}`, body: "Body", html_url: `https://github.com/o/r/issues/${number}`, created_at: "", user: { login: "ghostbuster3210" }, labels: labels.map((name) => ({ name })) });

test("security issues rank with security alerts, bugs ahead of enhancements", () => {
  assert.equal(issueRank(["security"], DEFAULT_ISSUE_LABELS), 1);
  assert.equal(issueRank(["bug"], DEFAULT_ISSUE_LABELS), 4);
  assert.equal(issueRank(["accessibility"], DEFAULT_ISSUE_LABELS), 5);
  assert.equal(issueRank(["enhancement"], DEFAULT_ISSUE_LABELS), 6);
});

test("issues marked as questions, duplicates or won't fix are skipped, as are unlabelled ones", () => {
  const picked = actionableIssues([issue(32, ["bug"]), issue(33, ["bug", "duplicate"]), issue(34, ["question"]), issue(35, []), issue(36, ["wontfix", "enhancement"])], DEFAULT_ISSUE_LABELS);
  assert.deepEqual(picked.map((i) => i.number), [32]);
  assert.equal(picked[0]?.author, "ghostbuster3210");
});

test("only fixed issues are closed by the pull request", () => {
  const issues = actionableIssues([issue(32, ["bug"]), issue(40, ["bug"])], DEFAULT_ISSUE_LABELS);
  const section = issuesSection([{ issue: 32, status: "fixed", note: "Leg animation keyframes were never registered." }, { issue: 40, status: "partial", note: "Needs a new model." }], issues);
  assert.match(section, /Fixes #32 \(fixed\)\. Leg animation/);
  assert.match(section, /Refs #40 \(partly fixed\)/);
});

test("issue results are only accepted for issues in this run", () => {
  writeFileSync(join(repo, OUTCOMES_FILE), JSON.stringify([{ issue: 32, status: "Partial", note: "Found it" }, { issue: 99, status: "fixed", note: "" }, { issue: 33, status: "done", note: "" }]));
  assert.deepEqual(readOutcomes(repo, new Set([32, 33])), [{ issue: 32, status: "partial", note: "Found it" }]);
});

test("handled markers keep alert and issue keys and still read the old marker", () => {
  const marker = handledMarker(["alert-12", "issue-32", "alert-12"]);
  assert.deepEqual(keysInMarker(`Body\n\n${marker}`), ["alert-12", "issue-32"]);
  assert.deepEqual(keysInMarker("<!-- semgrep-findings: abc def -->"), ["abc", "def"]);
});
