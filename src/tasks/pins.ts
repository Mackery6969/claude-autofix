import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./semgrep.ts";

const MUTABLE_TAG_RULE = /github-actions-mutable-action-tag$/;
const USES = /^(?<prefix>\s*(?:-\s+)?uses:\s*)(?<quote>["']?)(?<owner>[\w.-]+)\/(?<repo>[\w.-]+)(?<subpath>\/[^@\s"']*)?@(?<ref>[^\s"'#]+)\k<quote>\s*(?:#.*)?$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

export interface Pin {
  finding: Finding;
  path: string;
  line: number;
  before: string;
  after: string;
  action: string;
  ref: string;
  sha: string;
}

export interface UsesReference {
  prefix: string;
  quote: string;
  repository: string;
  subpath: string;
  ref: string;
}

export function isMutableTag(finding: Finding): boolean {
  return MUTABLE_TAG_RULE.test(finding.check_id);
}

export function parseUses(line: string): UsesReference | undefined {
  const match = USES.exec(line)?.groups;
  if (!match || FULL_SHA.test(match.ref ?? "")) return undefined;
  return { prefix: match.prefix ?? "", quote: match.quote ?? "", repository: `${match.owner}/${match.repo}`, subpath: match.subpath ?? "", ref: match.ref ?? "" };
}

export function pinnedLine(uses: UsesReference, sha: string): string {
  return `${uses.prefix}${uses.quote}${uses.repository}${uses.subpath}@${sha}${uses.quote} # ${uses.ref}`;
}

export async function resolvePins(findings: Finding[], cwd: string, commitSha: (repository: string, ref: string) => Promise<string>): Promise<Pin[]> {
  const shas = new Map<string, Promise<string | undefined>>();
  const pins: Pin[] = [];
  for (const finding of findings.filter(isMutableTag)) {
    const before = readLine(cwd, finding.path, finding.start.line);
    const uses = before === undefined ? undefined : parseUses(before);
    if (!uses || before === undefined) continue;
    const key = `${uses.repository}@${uses.ref}`;
    if (!shas.has(key)) shas.set(key, commitSha(uses.repository, uses.ref).catch(() => undefined));
    const sha = await shas.get(key);
    if (!sha || !FULL_SHA.test(sha)) continue;
    pins.push({ finding, path: finding.path, line: finding.start.line, before, after: pinnedLine(uses, sha), action: `${uses.repository}${uses.subpath}`, ref: uses.ref, sha });
  }
  return pins;
}

export function applyPins(pins: Pin[], cwd: string): void {
  const byFile = Map.groupBy(pins, (pin) => pin.path);
  for (const [path, filePins] of byFile) {
    const file = join(cwd, path);
    const lines = readFileSync(file, "utf8").split("\n");
    for (const pin of filePins) {
      const current = lines[pin.line - 1] ?? "";
      const lineEnding = current.endsWith("\r") ? "\r" : "";
      if (current.replace(/\r$/, "") === pin.before) lines[pin.line - 1] = `${pin.after}${lineEnding}`;
    }
    writeFileSync(file, lines.join("\n"));
  }
}

function readLine(cwd: string, path: string, line: number): string | undefined {
  try {
    return readFileSync(join(cwd, path), "utf8").split("\n")[line - 1]?.replace(/\r$/, "");
  } catch {
    return undefined;
  }
}
