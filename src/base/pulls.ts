import type { GitHub, PullRequestFile } from "./github.ts";

export interface PullRequestEvent {
  number: number;
  draft?: boolean;
  user: { login: string; type: string };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string };
}

export interface ChangeSet {
  pullRequest: number | undefined;
  branch: string;
  sha: string;
  base: string;
  author: { login: string; type: string };
  draft: boolean;
  fromFork: boolean;
}

export type PullRequestMode = "commit" | "pull-request";

export function changeSetFromPullRequest(pull: PullRequestEvent, repository: string): ChangeSet {
  return {
    pullRequest: pull.number,
    branch: pull.head.ref,
    sha: pull.head.sha,
    base: pull.base.ref,
    author: pull.user,
    draft: Boolean(pull.draft),
    fromFork: pull.head.repo?.full_name !== repository,
  };
}

export function changeSetName(changes: ChangeSet): string {
  return changes.pullRequest ? `#${changes.pullRequest}` : `\`${changes.branch}\``;
}

export function alertsRef(changes: ChangeSet): string {
  return changes.pullRequest ? `refs/pull/${changes.pullRequest}/merge` : `refs/heads/${changes.branch}`;
}

export async function filesChanged(github: GitHub, changes: ChangeSet): Promise<PullRequestFile[]> {
  return changes.pullRequest ? github.pullRequestFiles(changes.pullRequest) : github.compareFiles(changes.base, changes.sha);
}

export function whyNotEligible(changes: ChangeSet, authors: string[]): string | undefined {
  if (changes.fromFork) return "it comes from a fork";
  if (changes.draft) return "it's a draft";
  if (changes.author.type === "Bot" || changes.branch.startsWith("claude/")) return "it was made by a bot";
  if (!authors.some((author) => author.toLowerCase() === changes.author.login.toLowerCase())) return `only changes by ${authors.join(", ")} are handled (pull-request-authors)`;
  return undefined;
}

export function addedLines(patch: string): Set<number> {
  const added = new Set<number>();
  let line = 0;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (text.startsWith("+")) added.add(line++);
    else if (!text.startsWith("-") && !text.startsWith("\\")) line++;
  }
  return added;
}

export type ChangedLines = Map<string, Set<number> | "whole-file">;

export function changedLines(files: PullRequestFile[]): ChangedLines {
  const changed: ChangedLines = new Map();
  for (const file of files) {
    if (file.status === "removed") continue;
    if (file.patch) changed.set(file.filename, addedLines(file.patch));
    else if (file.status === "added") changed.set(file.filename, "whole-file");
  }
  return changed;
}

export function touchesChangedLines(changed: ChangedLines, path: string, start: number, end: number): boolean {
  const lines = changed.get(path);
  if (!lines) return false;
  if (lines === "whole-file") return true;
  for (let line = start; line <= end; line++) if (lines.has(line)) return true;
  return false;
}
