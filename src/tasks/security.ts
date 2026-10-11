import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { annotate, log, notice, setOutput, summary, warn } from "../base/actions.ts";
import { checkoutBranchAt, lastCommitIsBy } from "../base/git.ts";
import { GitHubError } from "../base/github.ts";
import { isInside, type PathRules } from "../base/paths.ts";
import { changedLines, touchesChangedLines, whyNotEligible, type PullRequestEvent, type PullRequestMode } from "../base/pulls.ts";
import { runHelperScript, type HelperScript } from "../base/scripts.ts";
import { ClaudeTask, commentMarker, commitMessage, type ClaudeReport, type Delivery, type Helpers, type PullRequestText, type TaskSettings } from "../base/task.ts";
import { applyPins, resolvePins, type Pin } from "./pins.ts";
import { bySeverity, ensureSemgrep, findingKey, findingsMarker, findingsTable, keysInMarker, RESULTS_FILE, rescanScript, sarifForUpload, scanRepository, type Finding, type Rules } from "./semgrep.ts";

export interface SecurityOptions {
  semgrepConfig: string[];
  semgrepExcludeRules: string[];
  semgrepVersion: string;
  uploadSarif: boolean;
  maxFindings: number;
  sha: string;
  ref: string;
  pullRequestMode: PullRequestMode;
  pullRequestAuthors: string[];
  pullRequest: PullRequestEvent | undefined;
}

interface Keyed {
  finding: Finding;
  key: string;
}

interface SecurityPlan {
  pull: PullRequestEvent | undefined;
  total: number;
  pending: number;
  batch: Keyed[];
  forClaude: Keyed[];
  applied: Pin[];
  suggested: Pin[];
  manual: Pin[];
  handledBefore: string[];
}

const WORKFLOWS = ".github/workflows";
const MESSAGE_LIMIT = 200;

export class SecurityTask extends ClaudeTask<SecurityPlan> {
  protected readonly name = "security";
  readonly #options: SecurityOptions;

  constructor(settings: TaskSettings, options: SecurityOptions) {
    super(settings);
    this.#options = options;
  }

  protected async plan(): Promise<SecurityPlan | undefined> {
    const findings = await this.scanAndReport();
    if (this.settings.eventName.startsWith("pull_request")) {
      const pull = this.#options.pullRequest;
      return pull ? this.planPullRequest(pull, findings) : undefined;
    }
    if (!(await this.onDefaultBranch())) {
      log("Scan only: Claude fixes findings on the default branch and on your own pull requests.");
      return undefined;
    }
    if (findings.length === 0) {
      log("No findings.");
      return undefined;
    }
    if (!this.claudeEnabled) return this.reportClaudeDisabled();

    const pulls = await this.ownPullRequests("all");
    const open = pulls.find((pull) => pull.state === "open");
    if (open && !this.settings.force) {
      log(`Waiting for ${open.html_url} to be merged or closed before triaging more findings. Run with force to replace it.`);
      return undefined;
    }
    const handled = new Set(this.settings.force ? [] : pulls.flatMap((pull) => keysInMarker(pull.body ?? "")));
    const pending = this.keyed(findings).filter(({ key }) => !handled.has(key));
    if (pending.length === 0) {
      log("Every finding is covered by an earlier pull request (merged or closed). Run with force to triage them again.");
      return undefined;
    }
    return this.prepare(undefined, pending, findings.length, []);
  }

  private async planPullRequest(pull: PullRequestEvent, findings: Finding[]): Promise<SecurityPlan | undefined> {
    const { github, workspace } = this.settings;
    const changed = changedLines(await github.pullRequestFiles(pull.number));
    const introduced = findings.filter((finding) => touchesChangedLines(changed, finding.path, finding.start.line, finding.end.line));
    const blocker = whyNotEligible(pull, github.repository, this.pullRequestAuthors) ?? (this.claudeEnabled ? undefined : "Claude isn't enabled for this repository");
    if (introduced.length === 0 || blocker) {
      await this.commentScanResults(pull, introduced, blocker);
      return undefined;
    }

    checkoutBranchAt({ ...this.pushOptions, branch: pull.head.ref, sha: pull.head.sha });
    if (lastCommitIsBy(workspace, this.settings.author)) {
      log(`The latest commit on #${pull.number} is already Claude's; leaving it for you to review.`);
      return undefined;
    }
    const onHead = scanRepository({ cwd: workspace, rules: this.rules, jsonPath: join(workspace, RESULTS_FILE), sarifPath: join(this.settings.tempDirectory, "semgrep-head.sarif") });
    const introducedOnHead = onHead.filter((finding) => touchesChangedLines(changed, finding.path, finding.start.line, finding.end.line));
    const handledBefore = keysInMarker((await github.findComment(pull.number, commentMarker(this.name)))?.body ?? "");
    const pending = this.keyed(introducedOnHead).filter(({ key }) => !handledBefore.includes(key));
    if (pending.length === 0) {
      log(`Every finding on #${pull.number}'s changed lines has already been handled.`);
      return undefined;
    }
    return this.prepare(pull, pending, introducedOnHead.length, handledBefore);
  }

  private async prepare(pull: PullRequestEvent | undefined, pending: Keyed[], total: number, handledBefore: string[]): Promise<SecurityPlan | undefined> {
    const { github, workspace } = this.settings;
    const batch = pending.sort((a, b) => bySeverity(a.finding, b.finding)).slice(0, this.#options.maxFindings);
    const pins = await resolvePins(batch.map(({ finding }) => finding), workspace, (repository, ref) => github.commitSha(repository, ref));
    const locked = this.canEditWorkflows ? [] : pins.filter((pin) => isInside(pin.path, WORKFLOWS));
    const applied = pins.filter((pin) => !locked.includes(pin));
    applyPins(applied, workspace);

    const plan: SecurityPlan = {
      pull,
      total,
      pending: pending.length,
      batch,
      forClaude: batch.filter(({ finding }) => !pins.some((pin) => pin.finding === finding)),
      applied,
      suggested: pull ? locked : [],
      manual: pull ? [] : locked,
      handledBefore,
    };
    if (pull) await this.suggestPins(pull, plan.suggested);
    writeFileSync(join(workspace, RESULTS_FILE), JSON.stringify({ results: plan.forClaude.map(({ finding }) => finding) }, null, 2));
    log(`Handling ${batch.length} of ${pending.length} new findings: ${pins.length} pinned without Claude, ${plan.forClaude.length} for Claude.`);

    if (plan.forClaude.length === 0 && applied.length === 0) {
      if (pull) await github.upsertComment(pull.number, commentMarker(this.name), `### Security fixes\n\n${this.pinsSection(plan)}\n\n${this.handledMarker(plan)}`);
      else summary(this.pinsSection(plan));
      return undefined;
    }
    return plan;
  }

  protected needsClaude(plan: SecurityPlan): boolean {
    return plan.forClaude.length > 0;
  }

  protected prompt(plan: SecurityPlan, helpers: Helpers): string {
    const workflowRule = this.canEditWorkflows
      ? "Files under .github/workflows/ may be edited if a finding is there."
      : 'Do not edit files under .github/workflows/: this run cannot push workflow changes. List findings there under "Needs a human".';
    const scope = plan.pull ? `on lines that pull request #${plan.pull.number} adds or changes` : "in this repository";
    return `Semgrep reported ${plan.total} finding(s) ${scope}. This run covers ${plan.forClaude.length} of them, listed in \`${RESULTS_FILE}\` at the repository root. Each result has \`check_id\` (the rule id), \`path\`, \`start.line\`/\`end.line\`, and \`extra.message\`. Findings that aren't in that file are out of scope for this run.

Triage every finding in the file. Follow the security policy in CLAUDE.md if the repository has one. Where it says nothing, use these defaults:

- Real flaw: fix it with the standard, well-tested mechanism for the language or library (parameterized queries, the framework's escaping API, constant-time comparison, argument-list subprocess calls, and so on). Do not write a custom string filter.
- False positive: do not change the logic. Directly above the flagged line, add one comment explaining why it is safe, then on the next line a suppression comment that ends the line, in the file's comment syntax: \`// nosemgrep: <check_id>\` or \`# nosemgrep: <check_id>\`. Use the full \`check_id\` from the results. Nothing may follow the rule id on that line, or Semgrep ignores it.
- Vendored or third-party code: do not patch it. List it under "Needs a human" and suggest updating the dependency or excluding the path.
- Never write a commit SHA, version number, checksum or URL you can't confirm from files in this repository; you have no network access to look them up. If a fix needs one, list the finding under "Needs a human" and say what to look up.
- ${workflowRule}

Change only what each finding needs. Do not refactor, reformat, or restyle anything else; security fixes and quality changes are kept apart. Do not start subagents.

${this.toolRules(helpers)}

When you are done:
1. Run \`${helpers.rescan}\` to list the findings left in the repository. Any of this run's findings still there must be listed under "Needs a human" with a reason.
2. Run \`${helpers.verify}\`. It must pass. If a fix breaks it and you can't repair the fix, revert that fix and list the finding under "Needs a human".
3. ${this.descriptionInstructions("Escape user input in the build download handler")} After the title: a one-sentence summary, then a table with one row per finding: rule, file:line, verdict (Fixed, False positive, or Needs a human), and a one-line reason. Do not commit; the workflow commits your changes.`;
  }

  protected helperScripts(): HelperScript[] {
    return [rescanScript(this.rules)];
  }

  protected scratchFiles(): string[] {
    return [RESULTS_FILE];
  }

  protected pathRules(): PathRules {
    return { area: ".", excluded: [] };
  }

  protected delivery(plan: SecurityPlan): Delivery {
    if (!plan.pull) return { kind: "new-pull-request" };
    if (this.#options.pullRequestMode === "commit") return { kind: "push", branch: plan.pull.head.ref, pullRequest: plan.pull.number };
    return { kind: "pull-request", branch: `${this.settings.branchPrefix}/pr-${plan.pull.number}`, base: plan.pull.head.ref };
  }

  protected pullRequest(plan: SecurityPlan, report: ClaudeReport): PullRequestText {
    const count = plan.batch.length;
    const description = [report.description, this.pinsSection(plan)].filter(Boolean).join("\n\n");
    const later = plan.pending > count ? ` The other ${plan.pending - count} follow ${plan.pull ? "on the next run" : "in the next pull request, once this one is merged or closed"}.` : "";
    const scope = plan.pull
      ? `This covers ${count} of the ${plan.pending} new findings on lines this pull request changes.${later}`
      : `This covers ${count} of the ${plan.pending} findings that hadn't been triaged yet.${later} Semgrep findings in the repository: **${plan.total}** before, **${this.remainingFindings()}** after this change.`;
    const ignoring = plan.pull ? "" : " Closing this pull request without merging it marks these findings as ignored; new or changed findings still come through.";
    const pinned = plan.applied.length + plan.suggested.length;
    const fallback = plan.forClaude.length === 0 && pinned > 0 ? `Pin ${pinned} GitHub Action${pinned === 1 ? "" : "s"} to commit SHAs` : `Triage ${count} Semgrep finding${count === 1 ? "" : "s"}`;
    const title = report.title ?? fallback;
    return {
      title,
      commitMessage: commitMessage("fix(security)", title, description),
      body: `${description}\n\n${scope}${this.footer(report)}${ignoring}\n\n${this.handledMarker(plan)}`,
    };
  }

  private get rules(): Rules {
    return { configs: this.#options.semgrepConfig, excludeRules: this.#options.semgrepExcludeRules };
  }

  private get pullRequestAuthors(): string[] {
    return this.#options.pullRequestAuthors.length ? this.#options.pullRequestAuthors : [this.settings.github.owner];
  }

  private keyed(findings: Finding[]): Keyed[] {
    return findings.map((finding) => ({ finding, key: findingKey(finding, this.settings.workspace) }));
  }

  private handledMarker(plan: SecurityPlan): string {
    return findingsMarker([...new Set([...plan.handledBefore, ...plan.batch.map(({ key }) => key)])]);
  }

  private remainingFindings(): string {
    const remaining = runHelperScript(join(this.settings.tempDirectory, "rescan.sh"));
    return remaining.ok ? String(remaining.stdout.split("\n").filter((line) => line.trim()).length) : "unknown";
  }

  private pinsSection(plan: SecurityPlan): string {
    const pinList = (pins: Pin[]) => pins.map((pin) => `- \`${pin.path}:${pin.line}\` ${pin.action}@${pin.ref} → \`${pin.sha.slice(0, 12)}\``).join("\n");
    const sections: string[] = [];
    if (plan.applied.length) sections.push(`Pinned to the commit each tag points to today:\n\n${pinList(plan.applied)}`);
    if (plan.suggested.length) sections.push(`Suggested as changes on this pull request, because workflow files can't be pushed without a pr-token:\n\n${pinList(plan.suggested)}`);
    if (plan.manual.length) sections.push(`Pin these by hand, because workflow files can't be pushed without a pr-token:\n\n${plan.manual.map((pin) => `- \`${pin.path}:${pin.line}\`: \`${pin.after.trim()}\``).join("\n")}`);
    return sections.join("\n\n");
  }

  private async suggestPins(pull: PullRequestEvent, pins: Pin[]): Promise<void> {
    try {
      await this.settings.github.suggestChanges(
        pull.number,
        pull.head.sha,
        "These actions are pinned to the commit their tag points to today. Workflow files can't be pushed with GITHUB_TOKEN, so commit the suggestions here, or pass a pr-token to have them pushed.",
        pins.map((pin) => ({ path: pin.path, line: pin.line, note: `Pin \`${pin.action}@${pin.ref}\` to \`${pin.sha}\`.`, replacement: pin.after })),
      );
    } catch (error) {
      warn(`Couldn't post the suggested pins: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async scanAndReport(): Promise<Finding[]> {
    const { workspace, tempDirectory } = this.settings;
    ensureSemgrep(this.#options.semgrepVersion);
    const sarifPath = join(tempDirectory, "semgrep.sarif");
    const findings = scanRepository({ cwd: workspace, rules: this.rules, jsonPath: join(workspace, RESULTS_FILE), sarifPath });
    setOutput("findings", findings.length);
    summary(`## Semgrep: ${findings.length} finding${findings.length === 1 ? "" : "s"}\n\n${findings.length ? findingsTable(findings) : ""}`);
    if (this.#options.uploadSarif) await this.uploadToCodeScanning(sarifPath);
    return findings;
  }

  private async commentScanResults(pull: PullRequestEvent, introduced: Finding[], reason: string | undefined): Promise<void> {
    for (const finding of introduced) {
      const level = finding.extra.severity.toUpperCase() === "ERROR" ? "error" : "warning";
      annotate(level, finding.extra.message, { file: finding.path, line: finding.start.line, endLine: finding.end.line, title: finding.check_id });
    }
    const { github } = this.settings;
    const marker = commentMarker(this.name);
    try {
      const existing = await github.findComment(pull.number, marker);
      if (introduced.length === 0 && !existing) {
        log(`No findings on the lines #${pull.number} changes.`);
        return;
      }
      const kept = findingsMarker(keysInMarker(existing?.body ?? ""));
      const body =
        introduced.length === 0
          ? "### Semgrep\n\nNo findings on the lines this pull request changes."
          : `### Semgrep: ${introduced.length} finding${introduced.length === 1 ? "" : "s"} on lines this pull request changes\n\n${scanTable(introduced)}${reason ? `\n\nNot fixed automatically: ${reason}.` : ""}`;
      await github.upsertComment(pull.number, marker, `${body}\n\n${kept}`);
      log(`Reported ${introduced.length} finding${introduced.length === 1 ? "" : "s"} on #${pull.number}.`);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 403) {
        notice("Couldn't comment on this pull request (pull requests from forks only get a read-only token). The findings are annotated on the changed lines instead.");
        return;
      }
      throw error;
    }
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
        notice(`Code scanning isn't available for this run, so findings are only in the job summary and on pull requests (${error.message}). Set upload-sarif: false to skip the upload.`);
      } else {
        warn(`Couldn't upload the findings to code scanning: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function scanTable(findings: Finding[]): string {
  const cell = (text: string) => text.replace(/\s+/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").slice(0, MESSAGE_LIMIT);
  const rows = findings.map((finding) => `| \`${finding.check_id.split(".").at(-1)}\` | \`${finding.path}:${finding.start.line}\` | ${finding.extra.severity} | ${cell(finding.extra.message)} |`);
  return ["| Rule | Location | Severity | Message |", "| --- | --- | --- | --- |", ...rows].join("\n");
}
