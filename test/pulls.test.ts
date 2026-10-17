import assert from "node:assert/strict";
import { test } from "node:test";
import { addedLines, alertsRef, changedLines, changeSetFromPullRequest, changeSetName, touchesChangedLines, whyNotEligible, type ChangeSet, type PullRequestEvent } from "../src/base/pulls.ts";

const patch = ["@@ -1,3 +1,4 @@", " line one", "-old two", "+new two", "+inserted", " line four", "@@ -10,2 +11,2 @@", " ten", "+eleven"].join("\n");

test("reads the new-file line numbers a patch adds", () => {
  assert.deepEqual([...addedLines(patch)].sort((a, b) => a - b), [2, 3, 12]);
});

test("treats new files without a patch as wholly changed and skips removed files", () => {
  const changed = changedLines([
    { filename: "a.yml", status: "modified", patch },
    { filename: "huge.js", status: "added" },
    { filename: "gone.js", status: "removed", patch },
  ]);
  assert.ok(touchesChangedLines(changed, "a.yml", 3, 3));
  assert.ok(!touchesChangedLines(changed, "a.yml", 4, 4));
  assert.ok(touchesChangedLines(changed, "a.yml", 4, 12));
  assert.ok(touchesChangedLines(changed, "huge.js", 999, 999));
  assert.ok(!touchesChangedLines(changed, "gone.js", 2, 2));
});

const pull = (overrides: Partial<PullRequestEvent> = {}): PullRequestEvent => ({
  number: 16,
  user: { login: "Mackery6969", type: "User" },
  head: { ref: "ai-stuff", sha: "abc", repo: { full_name: "Mackery6969/repo" } },
  base: { ref: "main" },
  ...overrides,
});

const eligibility = (overrides: Partial<PullRequestEvent> = {}, authors = ["Mackery6969"]) => whyNotEligible(changeSetFromPullRequest(pull(overrides), "Mackery6969/repo"), authors);

const branch = (overrides: Partial<ChangeSet> = {}): ChangeSet => ({
  pullRequest: undefined,
  branch: "feature/login",
  sha: "def",
  base: "main",
  author: { login: "Mackery6969", type: "User" },
  draft: false,
  fromFork: false,
  ...overrides,
});

test("only your own, non-draft, same-repository pull requests are eligible", () => {
  assert.equal(eligibility({}, ["mackery6969"]), undefined);
  assert.match(eligibility({ head: { ref: "x", sha: "abc", repo: { full_name: "stranger/repo" } } }) ?? "", /fork/);
  assert.match(eligibility({ draft: true }) ?? "", /draft/);
  assert.match(eligibility({ user: { login: "dependabot[bot]", type: "Bot" } }) ?? "", /bot/);
  assert.match(eligibility({ head: { ref: "claude/security-fixes", sha: "abc", repo: { full_name: "Mackery6969/repo" } } }) ?? "", /bot/);
  assert.match(eligibility({ user: { login: "collaborator", type: "User" } }) ?? "", /pull-request-authors/);
});

test("a pull request's changes run from its head against its base", () => {
  const changes = changeSetFromPullRequest(pull(), "Mackery6969/repo");
  assert.deepEqual([changes.branch, changes.sha, changes.base, changes.pullRequest], ["ai-stuff", "abc", "main", 16]);
  assert.equal(alertsRef(changes), "refs/pull/16/merge");
  assert.equal(changeSetName(changes), "#16");
});

test("a branch without a pull request is checked against the default branch by whoever ran it", () => {
  assert.equal(whyNotEligible(branch(), ["Mackery6969"]), undefined);
  assert.match(whyNotEligible(branch({ author: { login: "collaborator", type: "User" } }), ["Mackery6969"]) ?? "", /pull-request-authors/);
  assert.match(whyNotEligible(branch({ branch: "claude/quality/x" }), ["Mackery6969"]) ?? "", /bot/);
  assert.equal(alertsRef(branch()), "refs/heads/feature/login");
  assert.equal(changeSetName(branch()), "`feature/login`");
});
