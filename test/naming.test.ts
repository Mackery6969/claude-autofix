import assert from "node:assert/strict";
import { test } from "node:test";
import { commitMessage, parseDescription, slugify } from "../src/base/task.ts";

test("takes the title from the description's first heading", () => {
  const { title, body } = parseDescription("# Use a guard clause in `load_env`.\n\nSummary here.\n\n- bullet");
  assert.equal(title, "Use a guard clause in load_env");
  assert.equal(body, "Summary here.\n\n- bullet");
});

test("a description without a heading has no title", () => {
  assert.deepEqual(parseDescription("Just a summary."), { title: undefined, body: "Just a summary." });
});

test("branch names are short, readable slugs of the title", () => {
  assert.equal(slugify("Use a guard clause in load_env"), "use-a-guard-clause-in-load-env");
  assert.equal(slugify("Escape user input in the build download handler and the update endpoint"), "escape-user-input-in-the-build-download-handler");
  assert.equal(slugify("Pin 2 GitHub Actions to commit SHAs"), "pin-2-github-actions-to-commit-shas");
  assert.equal(slugify("!!!"), "changes");
});

test("commit messages read like conventional commits", () => {
  assert.equal(commitMessage("refactor", "Use a guard clause in load_env", "Body."), "refactor: use a guard clause in load_env\n\nBody.");
  assert.equal(commitMessage("fix(security)", "SHA-pin workflow actions", ""), "fix(security): SHA-pin workflow actions");
});
