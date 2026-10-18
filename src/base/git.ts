import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

export interface Identity {
  name: string;
  email: string;
}

export const GITHUB_ACTIONS_BOT: Identity = { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" };

export function botIdentity(slug: string, userId: number): Identity {
  return { name: `${slug}[bot]`, email: `${userId}+${slug}[bot]@users.noreply.github.com` };
}

export interface ChangedFile {
  path: string;
  tracked: boolean;
}

export function git(args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): string {
  const result = spawnSync("git", args, { cwd: options.cwd, env: options.env ?? process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

export function changedFiles(cwd: string): ChangedFile[] {
  const modified = splitNul(git(["diff", "-z", "--name-only", "--no-renames", "HEAD"], { cwd })).map((path) => ({ path, tracked: true }));
  const added = splitNul(git(["ls-files", "-z", "--others", "--exclude-standard"], { cwd })).map((path) => ({ path, tracked: false }));
  return [...modified, ...added];
}

export function hasChanges(cwd: string): boolean {
  return changedFiles(cwd).length > 0;
}

export function restore(file: ChangedFile, cwd: string): void {
  if (file.tracked) git(["restore", "--source=HEAD", "--staged", "--worktree", "--", file.path], { cwd });
  else rmSync(join(cwd, file.path), { force: true });
}

export interface PushOptions {
  cwd: string;
  branch: string;
  token: string;
  serverUrl: string;
  repository: string;
}

export function commitAll(cwd: string, branch: string, message: string, author: Identity): void {
  git(["checkout", "-B", branch], { cwd });
  git(["add", "-A"], { cwd });
  git(["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--no-verify", "-m", message], { cwd });
}

export function currentCommit(cwd: string): string {
  return git(["rev-parse", "HEAD"], { cwd }).trim();
}

export function resetTo(cwd: string, sha: string): void {
  git(["checkout", "--quiet", "--detach", sha], { cwd });
  git(["reset", "--hard", "--quiet", sha], { cwd });
  git(["clean", "-fdq"], { cwd });
}

export function discardUncommitted(cwd: string): void {
  git(["reset", "--hard", "--quiet", "HEAD"], { cwd });
  git(["clean", "-fdq"], { cwd });
}

export function forcePush(options: PushOptions): void {
  git(["push", "--force", remoteUrl(options), `HEAD:refs/heads/${options.branch}`], { cwd: options.cwd, env: authenticatedEnvironment(options) });
}

export function pushIfUnchanged(options: PushOptions): boolean {
  const result = spawnSync("git", ["push", remoteUrl(options), `HEAD:refs/heads/${options.branch}`], { cwd: options.cwd, env: authenticatedEnvironment(options), encoding: "utf8" });
  if (result.status === 0) return true;
  if (/rejected|non-fast-forward|fetch first/i.test(result.stderr)) return false;
  throw new Error(`git push failed: ${result.stderr.trim()}`);
}

export function checkoutBranchAt(options: PushOptions & { sha: string }): void {
  const { cwd, branch, sha } = options;
  if (currentCommit(cwd) !== sha) {
    git(["fetch", "--no-tags", remoteUrl(options), `+refs/heads/${branch}:refs/remotes/autofix/${branch}`], { cwd, env: authenticatedEnvironment(options) });
  }
  git(["checkout", "--quiet", "-B", branch, sha], { cwd });
}

export function lastCommitIsBy(cwd: string, author: Identity): boolean {
  return git(["log", "-1", "--format=%ae"], { cwd }).trim() === author.email;
}

function remoteUrl(options: PushOptions): string {
  return `${options.serverUrl}/${options.repository}.git`;
}

function authenticatedEnvironment(options: PushOptions): NodeJS.ProcessEnv {
  const credentials = Buffer.from(`x-access-token:${options.token}`).toString("base64");
  const key = `http.${options.serverUrl}/.extraheader`;
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: key,
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: key,
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${credentials}`,
  };
}

function splitNul(output: string): string[] {
  return output.split("\0").filter(Boolean);
}
