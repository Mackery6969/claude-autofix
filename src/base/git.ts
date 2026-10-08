import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

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
  const modified = splitNul(git(["diff", "-z", "--name-only"], { cwd })).map((path) => ({ path, tracked: true }));
  const added = splitNul(git(["ls-files", "-z", "--others", "--exclude-standard"], { cwd })).map((path) => ({ path, tracked: false }));
  return [...modified, ...added];
}

export function hasChanges(cwd: string): boolean {
  return changedFiles(cwd).length > 0;
}

export function restore(file: ChangedFile, cwd: string): void {
  if (file.tracked) git(["checkout", "--", file.path], { cwd });
  else rmSync(join(cwd, file.path), { force: true });
}

export interface PushOptions {
  cwd: string;
  branch: string;
  token: string;
  serverUrl: string;
  repository: string;
}

export function commitAll(cwd: string, branch: string, message: string): void {
  git(["checkout", "-B", branch], { cwd });
  git(["add", "-A"], { cwd });
  git(["-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`, "commit", "--no-verify", "-m", message], { cwd });
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
  if (git(["rev-parse", "HEAD"], { cwd }).trim() !== sha) {
    git(["fetch", "--no-tags", remoteUrl(options), `+refs/heads/${branch}:refs/remotes/autofix/${branch}`], { cwd, env: authenticatedEnvironment(options) });
  }
  git(["checkout", "--quiet", "-B", branch, sha], { cwd });
}

export function lastCommitIsFromBot(cwd: string): boolean {
  return git(["log", "-1", "--format=%ae"], { cwd }).trim() === BOT_EMAIL;
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
