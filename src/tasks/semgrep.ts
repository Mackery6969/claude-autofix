import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { log, untrustedOutput } from "../base/actions.ts";
import { withoutRunnerSecrets } from "../base/claude.ts";
import type { HelperScript } from "../base/scripts.ts";
import { shellQuote } from "../base/scripts.ts";

export const RESULTS_FILE = "semgrep-results.json";

export interface Finding {
  check_id: string;
  path: string;
  start: { line: number };
  end: { line: number };
  extra: { message: string; severity: string };
}

export interface ScanOptions {
  cwd: string;
  configs: string[];
  jsonPath: string;
  sarifPath: string;
}

export function ensureSemgrep(version: string): void {
  if (spawnSync("semgrep", ["--version"], { encoding: "utf8" }).status === 0) return;
  log(`Installing Semgrep ${version}`);
  const install = spawnSync("pipx", ["install", `semgrep==${version}`], { stdio: "inherit", env: withoutRunnerSecrets() });
  if (install.status !== 0 || spawnSync("semgrep", ["--version"]).status !== 0) throw new Error(`Couldn't install Semgrep ${version} with pipx.`);
}

export function scanRepository(options: ScanOptions): Finding[] {
  const args = ["scan", ...configArgs(options.configs), "--metrics=off", "--disable-version-check", `--json-output=${options.jsonPath}`, `--sarif-output=${options.sarifPath}`];
  const scan = spawnSync("semgrep", args, { cwd: options.cwd, encoding: "utf8", env: withoutRunnerSecrets(), maxBuffer: 256 * 1024 * 1024 });
  untrustedOutput("Semgrep", () => log(`${scan.stdout ?? ""}${scan.stderr ?? ""}`));
  if (scan.status !== 0) throw new Error(`Semgrep failed with exit code ${scan.status}. See the Semgrep log group above.`);
  return (JSON.parse(readFileSync(options.jsonPath, "utf8")) as { results: Finding[] }).results;
}

const SEVERITY_ORDER = ["ERROR", "WARNING", "INFO"];
const MARKER = /<!-- semgrep-findings: ([^>]*?) -->/;

export function findingKey(finding: Finding, cwd: string): string {
  return createHash("sha256").update(`${finding.check_id}\0${finding.path}\0${matchedCode(finding, cwd)}`).digest("hex").slice(0, 12);
}

function matchedCode(finding: Finding, cwd: string): string {
  try {
    const lines = readFileSync(join(cwd, finding.path), "utf8").split("\n");
    return lines
      .slice(finding.start.line - 1, finding.end.line)
      .map((line) => line.trim())
      .join("\n");
  } catch {
    return "";
  }
}

export function findingsMarker(keys: string[]): string {
  return `<!-- semgrep-findings: ${keys.join(" ")} -->`;
}

export function keysInMarker(body: string): string[] {
  return MARKER.exec(body)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
}

export function bySeverity(a: Finding, b: Finding): number {
  const rank = (finding: Finding) => {
    const index = SEVERITY_ORDER.indexOf(finding.extra.severity.toUpperCase());
    return index === -1 ? SEVERITY_ORDER.length : index;
  };
  return rank(a) - rank(b) || a.path.localeCompare(b.path) || a.start.line - b.start.line;
}

export function rescanScript(configs: string[]): HelperScript {
  const excludes = [RESULTS_FILE, ".claude-pr.md"].flatMap((file) => ["--exclude", file]);
  const command = ["semgrep", "scan", ...configArgs(configs), "--metrics=off", "--disable-version-check", "--quiet", "--json", ...excludes].map(shellQuote).join(" ");
  return { name: "rescan.sh", body: `${command} | jq -r '.results[] | "\\(.check_id) \\(.path):\\(.start.line)"'` };
}

export function sarifForUpload(sarifPath: string): string {
  const sarif = JSON.parse(readFileSync(sarifPath, "utf8")) as { runs?: Array<Record<string, unknown>> };
  for (const run of sarif.runs ?? []) run.automationDetails = { id: "semgrep/" };
  return gzipSync(Buffer.from(JSON.stringify(sarif))).toString("base64");
}

export function findingsTable(findings: Finding[]): string {
  const rows = findings.map((finding) => `| \`${finding.check_id}\` | \`${finding.path}:${finding.start.line}\` | ${finding.extra.severity} |`);
  return ["| Rule | Location | Severity |", "| --- | --- | --- |", ...rows].join("\n");
}

function configArgs(configs: string[]): string[] {
  return configs.flatMap((config) => ["--config", config]);
}
