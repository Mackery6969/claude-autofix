import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { changedFiles, commitAll, discardUncommitted, git, restore } from "../src/base/git.ts";

let repo = "";

before(() => {
  repo = mkdtempSync(join(tmpdir(), "claude-autofix-git-"));
  git(["init", "--quiet", "-b", "main"], { cwd: repo });
  git(["config", "core.autocrlf", "false"], { cwd: repo });
  writeFileSync(join(repo, "kept.txt"), "original\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  git(["add", "-A"], { cwd: repo });
  git(["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "init"], { cwd: repo });
});

after(() => rmSync(repo, { recursive: true, force: true }));

test("lists edited and new files, ignoring gitignored ones, and restores them", () => {
  writeFileSync(join(repo, "kept.txt"), "edited\n");
  writeFileSync(join(repo, "new file.txt"), "new\n");
  mkdirSync(join(repo, "node_modules"));
  writeFileSync(join(repo, "node_modules", "ignored.js"), "");

  const changes = changedFiles(repo).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(changes, [
    { path: "kept.txt", tracked: true },
    { path: "new file.txt", tracked: false },
  ]);

  for (const change of changes) restore(change, repo);
  assert.deepEqual(changedFiles(repo), []);
  assert.equal(readFileSync(join(repo, "kept.txt"), "utf8"), "original\n");
});

test("commits onto the bot branch and throws away what verification left behind", () => {
  writeFileSync(join(repo, "kept.txt"), "fixed\n");
  commitAll(repo, "claude/security-fixes", "fix(security): triage Semgrep findings");

  writeFileSync(join(repo, "build-output.txt"), "generated\n");
  writeFileSync(join(repo, "kept.txt"), "touched by the build\n");
  discardUncommitted(repo);

  assert.deepEqual(changedFiles(repo), []);
  assert.equal(readFileSync(join(repo, "kept.txt"), "utf8"), "fixed\n");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo }).trim(), "claude/security-fixes");
  assert.equal(git(["log", "-1", "--format=%an <%ae>|%s"], { cwd: repo }).trim(), "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>|fix(security): triage Semgrep findings");
});
