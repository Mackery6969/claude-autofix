import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log, summary, warn } from "../base/actions.ts";
import type { CodeScanningAlert, GitHub } from "../base/github.ts";

export const ALERTS_FILE = "code-scanning-alerts.json";
export const DISMISSALS_FILE = ".claude-dismissals.json";

const DISMISS_REASONS = ["false positive", "won't fix", "used in tests"] as const;
const COMMENT_LIMIT = 280;
const SECURITY_RANK = ["critical", "high", "medium", "low"];
const SEVERITY_RANK = ["error", "warning", "note"];

export type DismissReason = (typeof DISMISS_REASONS)[number];

export interface Alert {
  number: number;
  tool: string;
  rule: string;
  description: string;
  severity: string;
  securityLevel: string | null;
  level: string;
  security: boolean;
  path: string;
  startLine: number;
  endLine: number;
  message: string;
  url: string;
}

export interface Dismissal {
  alert: number;
  reason: DismissReason;
  comment: string;
}

export type ScannerFilter = { kind: "all" } | { kind: "none" } | { kind: "only"; tools: string[] };

export function parseScannerFilter(value: string): ScannerFilter {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "" || trimmed === "all") return { kind: "all" };
  if (trimmed === "none") return { kind: "none" };
  return { kind: "only", tools: value.split(/[\n,]/).map((tool) => tool.trim().toLowerCase()).filter(Boolean) };
}

export function isSecurityAlert(alert: CodeScanningAlert): boolean {
  return Boolean(alert.rule.security_severity_level) || (alert.rule.tags ?? []).some((tag) => tag.toLowerCase() === "security");
}

export function fromOtherScanners(alerts: CodeScanningAlert[], filter: ScannerFilter): Alert[] {
  if (filter.kind === "none") return [];
  return alerts
    .filter((alert) => !alert.tool.name.toLowerCase().startsWith("semgrep"))
    .filter((alert) => filter.kind === "all" || filter.tools.includes(alert.tool.name.toLowerCase()))
    .map(toAlert);
}

export function toAlert(alert: CodeScanningAlert): Alert {
  const location = alert.most_recent_instance.location;
  return {
    number: alert.number,
    tool: alert.tool.name,
    rule: alert.rule.id,
    description: alert.rule.description,
    severity: alert.rule.security_severity_level ?? alert.rule.severity ?? "warning",
    securityLevel: alert.rule.security_severity_level,
    level: alert.rule.severity ?? "warning",
    security: isSecurityAlert(alert),
    path: location.path,
    startLine: location.start_line,
    endLine: location.end_line,
    message: alert.most_recent_instance.message.text,
    url: alert.html_url,
  };
}

export function alertKey(alert: Alert): string {
  return `alert-${alert.number}`;
}

export function alertRank(alert: Alert): number {
  const security = SECURITY_RANK.indexOf((alert.securityLevel ?? "").toLowerCase());
  if (security !== -1) return security;
  const level = SEVERITY_RANK.indexOf(alert.level.toLowerCase());
  const general = level === -1 ? 1 : level;
  return alert.security ? 1 + general : SECURITY_RANK.length + general;
}

export function writeAlertsFile(cwd: string, alerts: Alert[]): void {
  const entries = alerts.map((alert) => ({ number: alert.number, tool: alert.tool, rule: alert.rule, kind: alert.security ? "security" : "issue", severity: alert.severity, path: alert.path, start_line: alert.startLine, end_line: alert.endLine, message: alert.message }));
  writeFileSync(join(cwd, ALERTS_FILE), JSON.stringify(entries, null, 2));
}

export function dismissalInstructions(): string {
  return `Findings in \`${ALERTS_FILE}\` come from other scanners (such as GML Code Scanner or CodeQL) and are open alerts on GitHub. Each has a \`kind\`: \`security\` for security problems, \`issue\` for everything else (bugs, performance, maintainability). Fix security alerts properly. For issues, fix what you can with focused changes; it's fine to resolve one only partly, as long as the description says what's left. Fix the real ones. For one that's a false positive, or that isn't worth changing, don't add a suppression comment: add it to \`${DISMISSALS_FILE}\` in the repository root, a JSON array of \`{"alert": <number>, "reason": "false positive" | "won't fix" | "used in tests", "comment": "<why, under ${COMMENT_LIMIT} characters>"}\`. The workflow dismisses those alerts on GitHub after you finish.`;
}

export function readDismissals(cwd: string, allowed: Set<number>): Dismissal[] {
  const path = join(cwd, DISMISSALS_FILE);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    warn(`${DISMISSALS_FILE} isn't valid JSON, so no alerts were dismissed.`);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: { alert?: unknown; reason?: unknown; comment?: unknown }) => {
    const alert = Number(entry?.alert);
    const reason = DISMISS_REASONS.find((candidate) => candidate === String(entry?.reason).toLowerCase());
    const comment = String(entry?.comment ?? "").trim().slice(0, COMMENT_LIMIT);
    if (!allowed.has(alert) || !reason || !comment) return [];
    return [{ alert, reason, comment }];
  });
}

export async function dismissAlerts(github: GitHub, dismissals: Dismissal[]): Promise<Dismissal[]> {
  const dismissed: Dismissal[] = [];
  for (const dismissal of dismissals) {
    try {
      await github.dismissAlert(dismissal.alert, dismissal.reason, `Claude: ${dismissal.comment}`.slice(0, COMMENT_LIMIT));
      dismissed.push(dismissal);
      log(`Dismissed alert #${dismissal.alert} (${dismissal.reason}).`);
    } catch (error) {
      warn(`Couldn't dismiss alert #${dismissal.alert}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (dismissed.length) summary(`Dismissed ${dismissed.length} alert${dismissed.length === 1 ? "" : "s"} on GitHub.`);
  return dismissed;
}

export function dismissalsSection(dismissed: Dismissal[], alerts: Alert[]): string {
  if (dismissed.length === 0) return "";
  const rows = dismissed.map((dismissal) => {
    const alert = alerts.find((candidate) => candidate.number === dismissal.alert);
    const label = alert ? `[#${alert.number}](${alert.url}) \`${alert.rule}\` in \`${alert.path}:${alert.startLine}\`` : `#${dismissal.alert}`;
    return `- ${label}: ${dismissal.reason}. ${dismissal.comment.replace(/\s+/g, " ")}`;
  });
  return `Dismissed on GitHub (reopen any you disagree with):\n\n${rows.join("\n")}`;
}
