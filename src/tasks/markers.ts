const MARKER = /<!-- (?:semgrep-findings|claude-handled): ([^>]*?) -->/g;

export function handledMarker(keys: string[]): string {
  return `<!-- claude-handled: ${[...new Set(keys)].join(" ")} -->`;
}

export function keysInMarker(body: string): string[] {
  return [...body.matchAll(MARKER)].at(-1)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
}

export const RETRY_AFTER_MERGE_MS = 24 * 60 * 60 * 1000;
export const MERGED_ATTEMPTS = 2;

export interface CoveringItem {
  body: string | null;
  merged_at?: string | null;
  pull_request?: unknown;
  number?: number;
  head?: unknown;
}

export interface Coverage {
  skip: Set<string>;
  retry: Map<string, number[]>;
}

function isPullRequest(item: CoveringItem): boolean {
  return item.head !== undefined;
}

export function coverage(items: CoveringItem[], now: Date): Coverage {
  const merges = new Map<string, Array<{ at: number; number: number | undefined }>>();
  const skip = new Set<string>();
  for (const item of items) {
    if (item.pull_request !== undefined && !isPullRequest(item)) continue;
    const merged = isPullRequest(item) && item.merged_at ? Date.parse(item.merged_at) : undefined;
    for (const key of keysInMarker(item.body ?? "")) {
      if (merged === undefined || key.startsWith("issue-")) skip.add(key);
      else merges.set(key, [...(merges.get(key) ?? []), { at: merged, number: item.number }]);
    }
  }
  const retry = new Map<string, number[]>();
  for (const [key, attempts] of merges) {
    if (skip.has(key)) continue;
    const latest = Math.max(...attempts.map((attempt) => attempt.at));
    if (attempts.length >= MERGED_ATTEMPTS || now.getTime() - latest < RETRY_AFTER_MERGE_MS) skip.add(key);
    else retry.set(key, attempts.flatMap((attempt) => (attempt.number === undefined ? [] : [attempt.number])));
  }
  return { skip, retry };
}
