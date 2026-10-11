import assert from "node:assert/strict";
import { test } from "node:test";
import { addedLines, changedLines, touchesChangedLines, whyNotEligible, type PullRequestEvent } from "../src/base/pulls.ts";

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
  ...overrides,
});

test("only your own, non-draft, same-repository pull requests are eligible", () => {
  assert.equal(whyNotEligible(pull(), "Mackery6969/repo", ["mackery6969"]), undefined);
  assert.match(whyNotEligible(pull({ head: { ref: "x", sha: "abc", repo: { full_name: "stranger/repo" } } }), "Mackery6969/repo", ["Mackery6969"]) ?? "", /fork/);
  assert.match(whyNotEligible(pull({ draft: true }), "Mackery6969/repo", ["Mackery6969"]) ?? "", /draft/);
  assert.match(whyNotEligible(pull({ user: { login: "dependabot[bot]", type: "Bot" } }), "Mackery6969/repo", ["Mackery6969"]) ?? "", /bot/);
  assert.match(whyNotEligible(pull({ head: { ref: "claude/security-fixes", sha: "abc", repo: { full_name: "Mackery6969/repo" } } }), "Mackery6969/repo", ["Mackery6969"]) ?? "", /bot/);
  assert.match(whyNotEligible(pull({ user: { login: "collaborator", type: "User" } }), "Mackery6969/repo", ["Mackery6969"]) ?? "", /pull-request-authors/);
});
