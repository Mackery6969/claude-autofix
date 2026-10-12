import { join } from "node:path";
import { log, summary, warn } from "../base/actions.ts";
import { askClaudeForText, installClaudeCode } from "../base/claude.ts";
import { checkoutBranchAt, lastCommitIsBy } from "../base/git.ts";
import { pauseRun } from "../base/pause.ts";
import { isInside, type PathRules } from "../base/paths.ts";
import { changedLines, touchesChangedLines, whyNotEligible, type PullRequestEvent, type PullRequestMode } from "../base/pulls.ts";
import { ClaudeTask, commentMarker, commitMessage, DESCRIPTION_FILE, type ClaudeReport, type Delivery, type Helpers, type PullRequestText, type TaskSettings } from "../base/task.ts";
import { ALERTS_FILE, alertKey, dismissAlerts, dismissalInstructions, dismissalsSection, DISMISSALS_FILE, fromScanners, readDismissals, writeAlertsFile, type Alert, type Dismissal, type ScannerFilter } from "./alerts.ts";
import {
  DEPENDABOT_FILE,
  dependabotInstructions,
  dependabotPullRequests,
  dependenciesSection,
  dependencyKey,
  dismissDependencies,
  escalationIssue,
  leftToDependabot,
  loadDependabotAlerts,
  needingEscalation,
  readVerdicts,
  VERDICTS_FILE,
  writeDependabotFile,
  type DependencyAlert,
  type DependencyVerdict,
} from "./dependencies.ts";
import { applyGrouping, byPriority, groupByRule, groupingPrompt, pinGroup, type Group } from "./groups.ts";
import { actionableIssues, commentOnIssues, issueInstructions, issueKey, issuesAlreadyAnswered, issuesSection, ISSUES_FILE, OUTCOMES_FILE, readOutcomes, writeIssuesFile, type IssueOutcome, type IssueWork } from "./issues.ts";
import { handledMarker, keysInMarker } from "./markers.ts";
import { applyPins, isUnpinnedAction, resolvePins, type Pin } from "./pins.ts";

export interface SecurityOptions {
  maxFindings: number;
  groupingModel: string;
  scanners: ScannerFilter;
  handleIssues: boolean;
  handleDependabot: boolean;
  issueLabels: string[];
  pullRequestMode: PullRequestMode;
  pullRequestAuthors: string[];
  pullRequest: PullRequestEvent | undefined;
}

interface SecurityPlan {
  pull: PullRequestEvent | undefined;
  group: Group;
  alerts: Alert[];
  issues: IssueWork[];
  dependencies: DependencyAlert[];
  applied: Pin[];
  suggested: Pin[];
  manual: Pin[];
  handledBefore: string[];
  dismissed: Dismissal[];
  outcomes: IssueOutcome[];
  verdicts: DependencyVerdict[];
}

const WORKFLOWS = ".github/workflows";
const GROUPING_BUDGET_USD = 0.5;

export class SecurityTask extends ClaudeTask<SecurityPlan> {
  protected readonly name = "security";
  readonly #options: SecurityOptions;

  constructor(settings: TaskSettings, options: SecurityOptions) {
    super(settings);
    this.#options = options;
  }

  protected async plan(): Promise<SecurityPlan[] | undefined> {
    const pull = this.#options.pullRequest;
    if (pull) return this.planPullRequest(pull);
    if (!(await this.onDefaultBranch())) {
      log("Nothing to do: Claude works on the default branch and on your own pull requests.");
      return undefined;
    }

    const { github, force } = this.settings;
    const alerts = fromScanners(await github.openAlerts(), this.#options.scanners);
    const dependencies = this.#options.handleDependabot ? await this.dependabotAlertsForClaude() : [];
    const issues = this.#options.handleIssues ? actionableIssues(await github.openIssues(), this.#options.issueLabels).filter((issue) => !this.isOwn(issue.author)) : [];
    if (alerts.length === 0 && dependencies.length === 0 && issues.length === 0) {
      log("No open code scanning alerts, Dependabot alerts or issues to work on.");
      return undefined;
    }
    if (!this.claudeEnabled) return this.reportClaudeDisabled();

    const handled = force ? new Set<string>() : await this.handledKeys();
    const answered = force ? new Set<number>() : await issuesAlreadyAnswered(github, issues.filter((issue) => !handled.has(issueKey(issue.number))));
    const pendingAlerts = alerts.filter((alert) => !handled.has(alertKey(alert)));
    const pendingDependencies = dependencies.filter((dependency) => !handled.has(dependencyKey(dependency)));
    const pendingIssues = issues.filter((issue) => !handled.has(issueKey(issue.number)) && !answered.has(issue.number));
    const pending = pendingAlerts.length + pendingDependencies.length + pendingIssues.length;
    summary(`## Open: ${count(alerts.length, "code scanning alert")}, ${count(dependencies.length, "Dependabot alert")}, ${count(issues.length, "issue")}; new: ${pending}`);
    if (pending === 0) {
      log("Everything open is already covered by a pull request, an issue or an issue comment. Run with force to look again.");
      return undefined;
    }

    const groups = await this.groups(pendingAlerts, pendingIssues, pendingDependencies);
    if (!groups) return undefined;
    summary(`Pull requests planned: ${groups.length}\n\n${groups.map((group) => `- ${group.label} (${group.alerts.length + group.dependencies.length + group.issues.length})`).join("\n")}\n`);
    return groups.map((group) => this.planFor(undefined, group, []));
  }

  private async dependabotAlertsForClaude(): Promise<DependencyAlert[]> {
    const { github } = this.settings;
    const alerts = await loadDependabotAlerts(github);
    if (alerts.length === 0) return [];
    const dependabotPulls = dependabotPullRequests(await github.openPullRequests());
    const now = new Date();
    return alerts.filter((alert) => {
      const reason = leftToDependabot(alert, dependabotPulls, now);
      if (reason) log(`Leaving Dependabot alert #${alert.number} (${alert.package}) alone: ${reason}.`);
      return !reason;
    });
  }

  private async handledKeys(): Promise<Set<string>> {
    const pulls = await this.ownPullRequests("all");
    const escalations = await this.settings.github.issuesCreatedBy(this.settings.author.name).catch((error: unknown) => {
      warn(`Couldn't list the issues Claude opened, so earlier escalations may be repeated: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    return new Set([...pulls, ...escalations].flatMap((item) => keysInMarker(item.body ?? "")));
  }

  private isOwn(login: string): boolean {
    return login.toLowerCase() === this.settings.author.name.toLowerCase();
  }

  private async groups(alerts: Alert[], issues: IssueWork[], dependencies: DependencyAlert[]): Promise<Group[] | undefined> {
    const size = this.#options.maxFindings;
    const pins = pinGroup(alerts);
    const rest = alerts.filter((alert) => !isUnpinnedAction(alert));
    if (rest.length + issues.length + dependencies.length <= 1) return byPriority([...pins, ...groupByRule(rest, issues, size, dependencies)]);

    const { workspace, tempDirectory, credentials } = this.settings;
    const outcome = await askClaudeForText({
      prompt: groupingPrompt(rest, issues, size, dependencies),
      cwd: workspace,
      model: this.#options.groupingModel,
      maxBudgetUsd: GROUPING_BUDGET_USD,
      credentials,
      executable: installClaudeCode(join(tempDirectory, "claude-code")),
    });
    if (outcome.kind === "limited") {
      await pauseRun(outcome.limit, { github: this.settings.github, runId: this.settings.runId, resumeWorkflow: this.settings.resumeWorkflow });
      return undefined;
    }
    const answer = outcome.result?.subtype === "success" ? outcome.result.result : "";
    const grouped = applyGrouping(answer, rest, issues, size, dependencies);
    if (!grouped) warn("Claude's grouping couldn't be read, so alerts are grouped by rule or package, one issue per pull request.");
    return byPriority([...pins, ...(grouped ?? groupByRule(rest, issues, size, dependencies))]);
  }

  private async planPullRequest(pull: PullRequestEvent): Promise<SecurityPlan[] | undefined> {
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
    return [this.planFor(pull, { label: `alerts on #${pull.number}`, alerts: pending, issues: [], dependencies: [], rank: 0 }, handledBefore)];
  }

  private planFor(pull: PullRequestEvent | undefined, group: Group, handledBefore: string[]): SecurityPlan {
    return { pull, group, alerts: [], issues: [], dependencies: [], applied: [], suggested: [], manual: [], handledBefore, dismissed: [], outcomes: [], verdicts: [] };
  }

  protected describe(plan: SecurityPlan): string {
    return plan.group.label;
  }

  protected async begin(plan: SecurityPlan): Promise<void> {
    const { github, workspace } = this.settings;
    const pins = await resolvePins(plan.group.alerts, workspace, (repository, ref) => github.commitSha(repository, ref));
    const locked = this.canEditWorkflows ? [] : pins.filter((pin) => isInside(pin.path, WORKFLOWS));
    plan.applied = pins.filter((pin) => !locked.includes(pin));
    plan.suggested = plan.pull ? locked : [];
    plan.manual = plan.pull ? [] : locked;
    applyPins(plan.applied, workspace);
    plan.alerts = plan.group.alerts.filter((alert) => !pins.some((pin) => pin.alert === alert));
    plan.issues = plan.group.issues;
    plan.dependencies = plan.group.dependencies;
    if (plan.pull) await this.suggestPins(plan.pull, plan.suggested);
    if (plan.alerts.length) writeAlertsFile(workspace, plan.alerts);
    if (plan.dependencies.length) writeDependabotFile(workspace, plan.dependencies);
    if (plan.issues.length) writeIssuesFile(workspace, plan.issues);
  }

  protected needsClaude(plan: SecurityPlan): boolean {
    return plan.alerts.length > 0 || plan.dependencies.length > 0 || plan.issues.length > 0;
  }

  protected async finished(plan: SecurityPlan): Promise<void> {
    const { github, workspace } = this.settings;
    if (plan.alerts.length) plan.dismissed = await dismissAlerts(github, readDismissals(workspace, new Set(plan.alerts.map((alert) => alert.number))));
    if (plan.dependencies.length) plan.verdicts = await dismissDependencies(github, readVerdicts(workspace, new Set(plan.dependencies.map((dependency) => dependency.number))));
    if (plan.issues.length) plan.outcomes = readOutcomes(workspace, new Set(plan.issues.map((issue) => issue.number)));
  }

  protected async delivered(plan: SecurityPlan, pullUrl: string | undefined): Promise<void> {
    if (plan.outcomes.length) await commentOnIssues(this.settings.github, plan.outcomes, pullUrl);
    await this.escalate(plan, pullUrl);
    if (pullUrl || (!plan.suggested.length && !plan.manual.length)) return;
    if (plan.pull) await this.settings.github.upsertComment(plan.pull.number, commentMarker(this.name), `### Pin GitHub Actions to commit SHAs\n\n${this.pinsSection(plan)}\n\n${this.marker(plan)}`);
    else summary(this.pinsSection(plan));
  }

  protected prompt(plan: SecurityPlan, helpers: Helpers): string {
    const workflowRule = this.canEditWorkflows
      ? "Files under .github/workflows/ may be edited if an alert is there."
      : 'Do not edit files under .github/workflows/: this run cannot push workflow changes. List alerts there under "Needs a human".';
    const scope = plan.pull ? `on lines that pull request #${plan.pull.number} adds or changes` : `grouped as "${plan.group.label}"`;
    const sections: string[] = [];
    if (plan.alerts.length) {
      sections.push(`${dismissalInstructions()}

How to handle the alerts, following the security policy in CLAUDE.md if the repository has one; where it says nothing:

- Real flaw: fix it with the standard, well-tested mechanism for the language or library (parameterized queries, the framework's escaping API, constant-time comparison, argument-list subprocess calls, and so on). Do not write a custom string filter.
- Vendored, generated or third-party code: do not patch it. Dismiss the alert as "won't fix" if it truly doesn't apply, or list it under "Needs a human". When you dismiss alerts from GML Code Scanner for a whole folder that it shouldn't scan, also add that folder to \`.gmlscanignore\` (\`.gitignore\` syntax, patterns relative to the file's folder; next to \`.gmlscan.json\` if there is one, otherwise in the scanned folder), so later scans skip it. Keep any lines already there.
- Never write a commit SHA, version number, checksum or URL you can't confirm from files in this repository; you have no network access to look them up. If a fix needs one, list the alert under "Needs a human" and say what to look up.
- ${workflowRule}`);
    }
    if (plan.dependencies.length) sections.push(dependabotInstructions());
    if (plan.issues.length) sections.push(issueInstructions());

    const covered = [
      `${plan.alerts.length} code scanning alert(s)${plan.alerts.length ? ` in \`${ALERTS_FILE}\`` : ""}`,
      `${plan.dependencies.length} Dependabot alert(s)${plan.dependencies.length ? ` in \`${DEPENDABOT_FILE}\`` : ""}`,
      `${plan.issues.length} issue(s)${plan.issues.length ? ` in \`${ISSUES_FILE}\`` : ""}`,
    ];
    return `This run covers ${covered.join(", ")}, at the repository root, ${scope}. They were grouped because they're related, so look for a shared cause or a shared fix. Anything not in these files is out of scope; other groups get their own pull requests.

${sections.join("\n\n")}

Change only what these items need. Do not refactor, reformat, or restyle anything else; quality changes are kept apart. Do not start subagents.

${this.toolRules(helpers)}

When you are done:
1. Run \`${helpers.verify}\`. It must pass. If a fix breaks it and you can't repair the fix, revert that fix and say so.
2. ${this.descriptionInstructions(this.exampleTitle(plan))} After the title: a one-sentence summary, then a table with one row per alert or issue: what it is, file:line, package or issue number, verdict (Fixed, Partly fixed, Dismissed, Escalated, or Needs a human), and a one-line reason. Do not commit; the workflow commits your changes.`;
  }

  protected scratchFiles(): string[] {
    return [ALERTS_FILE, DISMISSALS_FILE, DEPENDABOT_FILE, VERDICTS_FILE, ISSUES_FILE, OUTCOMES_FILE, DESCRIPTION_FILE];
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
    const items = plan.group.alerts.length + plan.group.dependencies.length + plan.group.issues.length;
    const description = [report.description, this.pinsSection(plan), dismissalsSection(plan.dismissed, plan.alerts), dependenciesSection(plan.dependencies, plan.verdicts), issuesSection(plan.outcomes, plan.issues)].filter(Boolean).join("\n\n");
    const scope = plan.pull ? `This covers the ${count(items, "code scanning alert")} on lines this pull request changes.` : `This covers ${count(items, "related item")} (${plan.group.label}). Other groups get their own pull requests.`;
    const ignoring = plan.pull ? "" : " Closing this pull request without merging it marks what it covers as handled.";
    const pinned = plan.applied.length + plan.suggested.length;
    const fallback = plan.alerts.length === 0 && plan.dependencies.length === 0 && plan.issues.length === 0 && pinned > 0 ? `Pin ${pinned} GitHub Action${pinned === 1 ? "" : "s"} to commit SHAs` : capitalize(plan.group.label);
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
    return handledMarker([...plan.handledBefore, ...plan.group.alerts.map(alertKey), ...plan.group.dependencies.map(dependencyKey), ...plan.group.issues.map((issue) => issueKey(issue.number))]);
  }

  private exampleTitle(plan: SecurityPlan): string {
    if (plan.alerts.length) return "Escape user input in the build download handler";
    if (plan.dependencies.length) return "Exclude the game's bundled lz4-java from Dependabot";
    return "Restore the walking animation for flesh mobs";
  }

  private async escalate(plan: SecurityPlan, pullUrl: string | undefined): Promise<void> {
    const alerts = needingEscalation(plan.dependencies, plan.verdicts, pullUrl);
    if (alerts.length === 0) return;
    const issue = escalationIssue(alerts, plan.verdicts, { pullUrl, runUrl: this.runUrl });
    try {
      const created = await this.settings.github.createIssue({ title: issue.title, body: `${issue.body}\n\n${handledMarker(alerts.map(dependencyKey))}`, labels: this.settings.labels });
      log(`Escalated ${count(alerts.length, "Dependabot alert")} in ${created.html_url}.`);
      summary(`Escalated ${count(alerts.length, "Dependabot alert")} for a person to decide: ${created.html_url}`);
    } catch (error) {
      warn(`Couldn't open an issue for ${count(alerts.length, "Dependabot alert")} that need a person: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    if (pins.length === 0) return;
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

function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? "" : "s"}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
