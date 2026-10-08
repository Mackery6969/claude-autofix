import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { log, notice, setOutput, summary, warn } from "../base/actions.ts";
import { GitHubError } from "../base/github.ts";
import type { PathRules } from "../base/paths.ts";
import { runHelperScript, type HelperScript } from "../base/scripts.ts";
import { ClaudeTask, DESCRIPTION_FILE, type ClaudeReport, type Helpers, type PullRequestText, type TaskSettings } from "../base/task.ts";
import { bySeverity, ensureSemgrep, findingKey, findingsMarker, findingsTable, keysInMarker, RESULTS_FILE, rescanScript, sarifForUpload, scanRepository, type Finding } from "./semgrep.ts";

export interface SecurityOptions {
  semgrepConfig: string[];
  semgrepVersion: string;
  uploadSarif: boolean;
  maxFindings: number;
  sha: string;
  ref: string;
}

interface SecurityPlan {
  batch: Array<{ finding: Finding; key: string }>;
  pending: number;
  total: number;
}

export class SecurityTask extends ClaudeTask<SecurityPlan> {
  protected readonly name = "security";
  readonly #options: SecurityOptions;

  constructor(settings: TaskSettings, options: SecurityOptions) {
    super(settings);
    this.#options = options;
  }

  protected async plan(): Promise<SecurityPlan | undefined> {
    const { workspace, tempDirectory, github, branch, force } = this.settings;
    ensureSemgrep(this.#options.semgrepVersion);
    const sarifPath = join(tempDirectory, "semgrep.sarif");
    const resultsPath = join(workspace, RESULTS_FILE);
    const findings = scanRepository({ cwd: workspace, configs: this.#options.semgrepConfig, jsonPath: resultsPath, sarifPath });
    setOutput("findings", findings.length);
    summary(`## Semgrep: ${findings.length} finding${findings.length === 1 ? "" : "s"}\n\n${findings.length ? findingsTable(findings) : ""}`);
    if (this.#options.uploadSarif) await this.uploadToCodeScanning(sarifPath);

    if (!(await this.onDefaultBranch())) {
      log("Scan only: Claude fixes findings on the default branch, not on pull requests or other branches.");
      return undefined;
    }
    if (findings.length === 0) {
      log("No findings.");
      return undefined;
    }

    const pulls = await github.pullRequests(branch, "all");
    const open = pulls.find((pull) => pull.state === "open");
    if (open && !force) {
      log(`Waiting for ${open.html_url} to be merged or closed before triaging more findings. Run with force to replace it.`);
      return undefined;
    }
    const handled = new Set(force ? [] : pulls.flatMap((pull) => keysInMarker(pull.body ?? "")));
    const pending = findings.map((finding) => ({ finding, key: findingKey(finding, workspace) })).filter(({ key }) => !handled.has(key));
    if (pending.length === 0) {
      log("Every finding is covered by an earlier pull request (merged or closed). Run with force to triage them again.");
      return undefined;
    }

    const batch = pending.sort((a, b) => bySeverity(a.finding, b.finding)).slice(0, this.#options.maxFindings);
    writeFileSync(resultsPath, JSON.stringify({ results: batch.map(({ finding }) => finding) }, null, 2));
    log(`Triaging ${batch.length} of ${pending.length} new findings (${findings.length} in total).`);
    return { batch, pending: pending.length, total: findings.length };
  }

  protected prompt(plan: SecurityPlan, helpers: Helpers): string {
    const workflowRule = this.canEditWorkflows
      ? "Files under .github/workflows/ may be edited if a finding is there."
      : 'Do not edit files under .github/workflows/: this run cannot push workflow changes. List findings there under "Needs a human".';
    return `Semgrep reported ${plan.total} finding(s) in this repository. This run covers ${plan.batch.length} of them, listed in \`${RESULTS_FILE}\` at the repository root. Each result has \`check_id\` (the rule id), \`path\`, \`start.line\`/\`end.line\`, and \`extra.message\`. Findings that aren't in that file are out of scope for this run.

Triage every finding in the file. Follow the security policy in CLAUDE.md if the repository has one. Where it says nothing, use these defaults:

- Real flaw: fix it with the standard, well-tested mechanism for the language or library (parameterized queries, the framework's escaping API, constant-time comparison, argument-list subprocess calls, and so on). Do not write a custom string filter.
- False positive: do not change the logic. Directly above the flagged line, add one comment explaining why it is safe, then on the next line a suppression comment that ends the line, in the file's comment syntax: \`// nosemgrep: <check_id>\` or \`# nosemgrep: <check_id>\`. Use the full \`check_id\` from the results. Nothing may follow the rule id on that line, or Semgrep ignores it.
- Vendored or third-party code: do not patch it. List it under "Needs a human" and suggest updating the dependency or excluding the path.
- ${workflowRule}

Change only what each finding needs. Do not refactor, reformat, or restyle anything else; security fixes and quality changes are kept in separate pull requests. Do not start subagents.

When you are done:
1. Run \`${helpers.rescan}\` to list the findings left in the repository. Any of this run's findings still there must be listed under "Needs a human" with a reason.
2. Run \`${helpers.verify}\`. It must pass. If a fix breaks it and you can't repair the fix, revert that fix and list the finding under "Needs a human".
3. Write the pull request description to \`${DESCRIPTION_FILE}\` in the repository root. Start with a one-sentence summary, then a table with one row per finding: rule, file:line, verdict (Fixed, False positive, or Needs a human), and a one-line reason. Do not commit; the workflow commits your changes and opens the pull request.`;
  }

  protected helperScripts(): HelperScript[] {
    return [rescanScript(this.#options.semgrepConfig)];
  }

  protected scratchFiles(): string[] {
    return [RESULTS_FILE];
  }

  protected pathRules(): PathRules {
    return { area: ".", excluded: [] };
  }

  protected pullRequest(plan: SecurityPlan, report: ClaudeReport): PullRequestText {
    const remaining = runHelperScript(join(this.settings.tempDirectory, "rescan.sh"));
    const after = remaining.ok ? String(remaining.stdout.split("\n").filter((line) => line.trim()).length) : "unknown";
    const count = plan.batch.length;
    const later = plan.pending > count ? ` The other ${plan.pending - count} come in the next pull request, once this one is merged or closed.` : "";
    return {
      title: `Security: triage ${count} Semgrep finding${count === 1 ? "" : "s"}`,
      commitMessage: "fix(security): triage Semgrep findings",
      body: `${report.description}

This covers ${count} of the ${plan.pending} findings that hadn't been triaged yet.${later} Semgrep findings in the repository: **${plan.total}** before, **${after}** after this change.${this.footer(report)} Closing this pull request without merging it marks these findings as ignored; new or changed findings still come through.

${findingsMarker(plan.batch.map(({ key }) => key))}`,
    };
  }

  private async uploadToCodeScanning(sarifPath: string): Promise<void> {
    try {
      const upload = await this.settings.github.uploadSarif({
        commit_sha: this.#options.sha,
        ref: this.#options.ref,
        sarif: sarifForUpload(sarifPath),
        tool_name: "Semgrep",
        checkout_uri: pathToFileURL(this.settings.workspace).href,
      });
      log(`Uploaded the findings to code scanning (upload ${upload.id}).`);
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) {
        notice(`Code scanning isn't available for this run, so findings are only in the job summary (${error.message}). Set upload-sarif: false to skip the upload.`);
      } else {
        warn(`Couldn't upload the findings to code scanning: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
