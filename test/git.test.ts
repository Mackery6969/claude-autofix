import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { botIdentity, changedFiles, commitAll, currentCommit, discardUncommitted, git, GITHUB_ACTIONS_BOT, lastCommitIsBy, resetTo, restore } from "../src/base/git.ts";

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
  commitAll(repo, "claude/security-fixes", "fix(security): triage Semgrep findings", GITHUB_ACTIONS_BOT);

  writeFileSync(join(repo, "build-output.txt"), "generated\n");
  writeFileSync(join(repo, "kept.txt"), "touched by the build\n");
  discardUncommitted(repo);

  assert.deepEqual(changedFiles(repo), []);
  assert.equal(readFileSync(join(repo, "kept.txt"), "utf8"), "fixed\n");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo }).trim(), "claude/security-fixes");
  assert.equal(git(["log", "-1", "--format=%an <%ae>|%s"], { cwd: repo }).trim(), "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>|fix(security): triage Semgrep findings");
});

test("each group starts again from the same commit, without the last group's work", () => {
  const start = currentCommit(repo);
  writeFileSync(join(repo, "kept.txt"), "group one\n");
  writeFileSync(join(repo, "group-one.txt"), "new file\n");
  commitAll(repo, "claude/security/group-one", "fix(security): group one", GITHUB_ACTIONS_BOT);
  writeFileSync(join(repo, "stray.txt"), "left over\n");
  resetTo(repo, start);
  assert.equal(currentCommit(repo), start);
  assert.deepEqual(changedFiles(repo), []);
  assert.equal(readFileSync(join(repo, "kept.txt"), "utf8"), "fixed\n");
});

test("commits as a GitHub App's bot and recognises its own commits", () => {
  const app = botIdentity("mackery-claude", 123456);
  assert.deepEqual(app, { name: "mackery-claude[bot]", email: "123456+mackery-claude[bot]@users.noreply.github.com" });
  writeFileSync(join(repo, "kept.txt"), "fixed again\n");
  commitAll(repo, "claude/code-quality", "refactor: code-quality pass", app);
  assert.ok(lastCommitIsBy(repo, app));
  assert.ok(!lastCommitIsBy(repo, GITHUB_ACTIONS_BOT));
});
