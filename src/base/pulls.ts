import { eventPayload } from "./actions.ts";
import type { PullRequestFile } from "./github.ts";

export interface PullRequestEvent {
  number: number;
  draft?: boolean;
  merged?: boolean;
  user: { login: string; type: string };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
}

export type PullRequestMode = "commit" | "pull-request";

export function pullRequestFromEvent(): PullRequestEvent | undefined {
  return eventPayload<{ pull_request?: PullRequestEvent }>()?.pull_request;
}

export function eventAction(): string {
  return eventPayload<{ action?: string }>()?.action ?? "";
}

export function whyNotEligible(pull: PullRequestEvent, repository: string, authors: string[]): string | undefined {
  if (pull.head.repo?.full_name !== repository) return "it comes from a fork";
  if (pull.draft) return "it's a draft";
  if (pull.user.type === "Bot" || pull.head.ref.startsWith("claude/")) return "it was opened by a bot";
  if (!authors.some((author) => author.toLowerCase() === pull.user.login.toLowerCase())) return `only pull requests by ${authors.join(", ")} are handled (pull-request-authors)`;
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
