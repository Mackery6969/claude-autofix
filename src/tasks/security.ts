import { log, summary, warn } from "../base/actions.ts";
import { checkoutBranchAt, lastCommitIsBy } from "../base/git.ts";
import { isInside, type PathRules } from "../base/paths.ts";
import { changedLines, touchesChangedLines, whyNotEligible, type PullRequestEvent, type PullRequestMode } from "../base/pulls.ts";
import { ClaudeTask, commentMarker, commitMessage, DESCRIPTION_FILE, type ClaudeReport, type Delivery, type Helpers, type PullRequestText, type TaskSettings } from "../base/task.ts";
import { ALERTS_FILE, alertKey, alertRank, dismissAlerts, dismissalInstructions, dismissalsSection, DISMISSALS_FILE, fromScanners, readDismissals, writeAlertsFile, type Alert, type Dismissal, type ScannerFilter } from "./alerts.ts";
import { actionableIssues, commentOnIssues, issueInstructions, issueKey, issuesAlreadyAnswered, issuesSection, ISSUES_FILE, OUTCOMES_FILE, readOutcomes, writeIssuesFile, type IssueOutcome, type IssueWork } from "./issues.ts";
import { handledMarker, keysInMarker } from "./markers.ts";
import { applyPins, resolvePins, type Pin } from "./pins.ts";

export interface SecurityOptions {
  maxFindings: number;
  scanners: ScannerFilter;
  handleIssues: boolean;
  issueLabels: string[];
  pullRequestMode: PullRequestMode;
  pullRequestAuthors: string[];
  pullRequest: PullRequestEvent | undefined;
}

interface SecurityPlan {
  pull: PullRequestEvent | undefined;
  total: number;
  pending: number;
  alerts: Alert[];
  issues: IssueWork[];
  applied: Pin[];
  suggested: Pin[];
  manual: Pin[];
  handledNow: string[];
  handledBefore: string[];
  dismissed: Dismissal[];
  outcomes: IssueOutcome[];
}

type Work = { rank: number; alert: Alert; issue?: undefined } | { rank: number; issue: IssueWork; alert?: undefined };

const WORKFLOWS = ".github/workflows";

export class SecurityTask extends ClaudeTask<SecurityPlan> {
  protected readonly name = "security";
  readonly #options: SecurityOptions;

  constructor(settings: TaskSettings, options: SecurityOptions) {
    super(settings);
    this.#options = options;
  }

  protected async plan(): Promise<SecurityPlan | undefined> {
    const pull = this.#options.pullRequest;
    if (pull) return this.planPullRequest(pull);
    if (!(await this.onDefaultBranch())) {
      log("Nothing to do: Claude works on the default branch and on your own pull requests.");
      return undefined;
    }

    const { github, force } = this.settings;
    const alerts = fromScanners(await github.openAlerts(), this.#options.scanners);
    const issues = this.#options.handleIssues ? actionableIssues(await github.openIssues(), this.#options.issueLabels) : [];
    summary(`## Open: ${alerts.length} code scanning alert${alerts.length === 1 ? "" : "s"}, ${issues.length} issue${issues.length === 1 ? "" : "s"} to work on`);
    if (alerts.length === 0 && issues.length === 0) {
      log("No open code scanning alerts or issues to work on.");
      return undefined;
    }
    if (!this.claudeEnabled) return this.reportClaudeDisabled();

    const pulls = await this.ownPullRequests("all");
    const open = pulls.find((candidate) => candidate.state === "open");
    if (open && !force) {
      log(`Waiting for ${open.html_url} to be merged or closed before taking on more. Run with force to replace it.`);
      return undefined;
    }
    const handled = new Set(force ? [] : pulls.flatMap((candidate) => keysInMarker(candidate.body ?? "")));
    const answered = force ? new Set<number>() : await issuesAlreadyAnswered(github, issues.filter((issue) => !handled.has(issueKey(issue.number))));
    const pendingAlerts = alerts.filter((alert) => !handled.has(alertKey(alert)));
    const pendingIssues = issues.filter((issue) => !handled.has(issueKey(issue.number)) && !answered.has(issue.number));
    if (pendingAlerts.length === 0 && pendingIssues.length === 0) {
      log("Everything open has already been handled by an earlier pull request or issue comment. Run with force to look again.");
      return undefined;
    }
    return this.prepare(undefined, pendingAlerts, pendingIssues, alerts.length + issues.length, []);
  }

  private async planPullRequest(pull: PullRequestEvent): Promise<SecurityPlan | undefined> {
    const { github, workspace } = this.settings;
    const ineligible = whyNotEligible(pull, github.repository, this.pullRequestAuthors);
    if (ineligible) {
      log(`Leaving #${pull.number} alone: ${ineligible}. GitHub still shows its code scanning results on the pull request.`);
      return undefined;
    }
    if (!this.claudeEnabled) return this.reportClaudeDisabled();

    const changed = changedLines(await github.pullRequestFiles(pull.number));
    const alerts = fromScanners(await github.openAlerts(`refs/pull/${pull.number}/merge`), this.#options.scanners).filter((alert) => touchesChangedLines(changed, alert.path, alert.startLine, alert.endLine));
    if (alerts.length === 0) {
      log(`No code scanning alerts on the lines #${pull.number} changes.`);
      return undefined;
    }
    checkoutBranchAt({ ...this.pushOptions, branch: pull.head.ref, sha: pull.head.sha });
    if (lastCommitIsBy(workspace, this.settings.author)) {
      log(`The latest commit on #${pull.number} is already Claude's; leaving it for you to review.`);
      return undefined;
    }
    const handledBefore = keysInMarker((await github.findComment(pull.number, commentMarker(this.name)))?.body ?? "");
    const pending = alerts.filter((alert) => !handledBefore.includes(alertKey(alert)));
    if (pending.length === 0) {
      log(`Every alert on #${pull.number}'s changed lines has already been handled.`);
      return undefined;
    }
    return this.prepare(pull, pending, [], alerts.length, handledBefore);
  }

  private async prepare(pull: PullRequestEvent | undefined, pendingAlerts: Alert[], pendingIssues: IssueWork[], total: number, handledBefore: string[]): Promise<SecurityPlan | undefined> {
    const { github, workspace } = this.settings;
    const work: Work[] = [...pendingAlerts.map((alert) => ({ rank: alertRank(alert), alert })), ...pendingIssues.map((issue) => ({ rank: issue.rank, issue }))]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, this.#options.maxFindings);
    const batchAlerts = work.flatMap((item) => (item.alert ? [item.alert] : []));
    const issues = work.flatMap((item) => (item.issue ? [item.issue] : []));

    const pins = await resolvePins(batchAlerts, workspace, (repository, ref) => github.commitSha(repository, ref));
    const locked = this.canEditWorkflows ? [] : pins.filter((pin) => isInside(pin.path, WORKFLOWS));
    const applied = pins.filter((pin) => !locked.includes(pin));
    applyPins(applied, workspace);
    const alerts = batchAlerts.filter((alert) => !pins.some((pin) => pin.alert === alert));

    const plan: SecurityPlan = {
      pull,
      total,
      pending: pendingAlerts.length + pendingIssues.length,
      alerts,
      issues,
      applied,
      suggested: pull ? locked : [],
      manual: pull ? [] : locked,
      handledNow: [...batchAlerts.map(alertKey), ...issues.map((issue) => issueKey(issue.number))],
      handledBefore,
      dismissed: [],
      outcomes: [],
    };
    if (pull) await this.suggestPins(pull, plan.suggested);
    if (alerts.length) writeAlertsFile(workspace, alerts);
    if (issues.length) writeIssuesFile(workspace, issues);
    log(`Taking on ${work.length} of ${plan.pending}: ${pins.length} action pin${pins.length === 1 ? "" : "s"} without Claude, ${alerts.length} alert${alerts.length === 1 ? "" : "s"} and ${issues.length} issue${issues.length === 1 ? "" : "s"} for Claude.`);

    if (alerts.length === 0 && issues.length === 0 && applied.length === 0) {
      if (pull) await github.upsertComment(pull.number, commentMarker(this.name), `### Pin GitHub Actions to commit SHAs\n\n${this.pinsSection(plan)}\n\n${this.marker(plan)}`);
      else summary(this.pinsSection(plan));
      return undefined;
    }
    return plan;
  }

  protected needsClaude(plan: SecurityPlan): boolean {
    return plan.alerts.length > 0 || plan.issues.length > 0;
  }

  protected async finished(plan: SecurityPlan): Promise<void> {
    const { github, workspace } = this.settings;
    if (plan.alerts.length) plan.dismissed = await dismissAlerts(github, readDismissals(workspace, new Set(plan.alerts.map((alert) => alert.number))));
    if (plan.issues.length) plan.outcomes = readOutcomes(workspace, new Set(plan.issues.map((issue) => issue.number)));
  }

  protected async delivered(plan: SecurityPlan, pullUrl: string | undefined): Promise<void> {
    if (plan.outcomes.length) await commentOnIssues(this.settings.github, plan.outcomes, pullUrl);
  }

  protected prompt(plan: SecurityPlan, helpers: Helpers): string {
    const workflowRule = this.canEditWorkflows
      ? "Files under .github/workflows/ may be edited if an alert is there."
      : 'Do not edit files under .github/workflows/: this run cannot push workflow changes. List alerts there under "Needs a human".';
    const scope = plan.pull ? `on lines that pull request #${plan.pull.number} adds or changes` : "for this repository";
    const sections: string[] = [];
    if (plan.alerts.length) {
      sections.push(`${dismissalInstructions()}

How to handle the alerts, following the security policy in CLAUDE.md if the repository has one; where it says nothing:

- Real flaw: fix it with the standard, well-tested mechanism for the language or library (parameterized queries, the framework's escaping API, constant-time comparison, argument-list subprocess calls, and so on). Do not write a custom string filter.
- Vendored or third-party code: do not patch it. Dismiss the alert as "won't fix" if it truly doesn't apply, or list it under "Needs a human".
- Never write a commit SHA, version number, checksum or URL you can't confirm from files in this repository; you have no network access to look them up. If a fix needs one, list the alert under "Needs a human" and say what to look up.
- ${workflowRule}`);
    }
    if (plan.issues.length) sections.push(issueInstructions());

    return `There are ${plan.total} open item(s) ${scope}. This run covers ${plan.alerts.length} code scanning alert(s)${plan.alerts.length ? ` in \`${ALERTS_FILE}\`` : ""} and ${plan.issues.length} issue(s)${plan.issues.length ? ` in \`${ISSUES_FILE}\`` : ""}, at the repository root, most important first. Anything not in these files is out of scope for this run.

${sections.join("\n\n")}

Change only what each item needs. Do not refactor, reformat, or restyle anything else; quality changes are kept apart. Do not start subagents.

${this.toolRules(helpers)}

When you are done:
1. Run \`${helpers.verify}\`. It must pass. If a fix breaks it and you can't repair the fix, revert that fix and say so.
2. ${this.descriptionInstructions(plan.alerts.length ? "Escape user input in the build download handler" : "Restore the walking animation for flesh mobs")} After the title: a one-sentence summary, then a table with one row per alert or issue: what it is, file:line or issue number, verdict (Fixed, Partly fixed, Dismissed, or Needs a human), and a one-line reason. Do not commit; the workflow commits your changes.`;
  }

  protected scratchFiles(): string[] {
    return [ALERTS_FILE, DISMISSALS_FILE, ISSUES_FILE, OUTCOMES_FILE, DESCRIPTION_FILE];
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
    const count = plan.handledNow.length;
    const description = [report.description, this.pinsSection(plan), dismissalsSection(plan.dismissed, plan.alerts), issuesSection(plan.outcomes, plan.issues)].filter(Boolean).join("\n\n");
    const later = plan.pending > count ? ` The other ${plan.pending - count} follow ${plan.pull ? "on the next run" : "in the next pull request, once this one is merged or closed"}.` : "";
    const scope = plan.pull ? `This covers ${count} of the ${plan.pending} new alerts on lines this pull request changes.${later}` : `This covers ${count} of the ${plan.pending} open alerts and issues that hadn't been handled yet.${later}`;
    const ignoring = plan.pull ? "" : " Closing this pull request without merging it marks what it covers as handled.";
    const pinned = plan.applied.length + plan.suggested.length;
    const fallback = plan.alerts.length === 0 && plan.issues.length === 0 && pinned > 0 ? `Pin ${pinned} GitHub Action${pinned === 1 ? "" : "s"} to commit SHAs` : `Fix ${count} code scanning alert${count === 1 ? "" : "s"} and issue${count === 1 ? "" : "s"}`;
    const title = report.title ?? fallback;
    return {
      title,
      commitMessage: commitMessage("fix(security)", title, description),
      body: `${description}\n\n${scope}${this.footer(report)}${ignoring}\n\n${this.marker(plan)}`,
    };
  }

  private get pullRequestAuthors(): string[] {
    return this.#options.pullRequestAuthors.length ? this.#options.pullRequestAuthors : [this.settings.github.owner];
  }

  private marker(plan: SecurityPlan): string {
    return handledMarker([...plan.handledBefore, ...plan.handledNow]);
  }

  private pinsSection(plan: SecurityPlan): string {
    const pinList = (pins: Pin[]) => pins.map((pin) => `- \`${pin.path}:${pin.line}\` ${pin.action}@${pin.ref} → \`${pin.sha.slice(0, 12)}\``).join("\n");
    const sections: string[] = [];
    if (plan.applied.length) sections.push(`Pinned to the commit each tag points to today:\n\n${pinList(plan.applied)}`);
    if (plan.suggested.length) sections.push(`Suggested as changes on this pull request, because workflow files can't be pushed without a token that may change them:\n\n${pinList(plan.suggested)}`);
    if (plan.manual.length) sections.push(`Pin these by hand, because workflow files can't be pushed without a token that may change them:\n\n${plan.manual.map((pin) => `- \`${pin.path}:${pin.line}\`: \`${pin.after.trim()}\``).join("\n")}`);
    return sections.join("\n\n");
  }

  private async suggestPins(pull: PullRequestEvent, pins: Pin[]): Promise<void> {
    try {
      await this.settings.github.suggestChanges(
        pull.number,
        pull.head.sha,
        "These actions are pinned to the commit their tag points to today. Workflow files can't be pushed with GITHUB_TOKEN, so commit the suggestions here, or use a GitHub App token to have them pushed.",
        pins.map((pin) => ({ path: pin.path, line: pin.line, note: `Pin \`${pin.action}@${pin.ref}\` to \`${pin.sha}\`.`, replacement: pin.after })),
      );
    } catch (error) {
      warn(`Couldn't post the suggested pins: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
