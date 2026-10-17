import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ActionFailure, log, notice, setOutput, summary, untrustedOutput, warn } from "./actions.ts";
import { hasCredentials, installClaudeCode, runClaude, type Credentials } from "./claude.ts";
import { changedFiles, checkoutBranchAt, commitAll, currentCommit, discardUncommitted, forcePush, git, lastCommitIsBy, pushIfUnchanged, resetTo, restore, type Identity, type PushOptions } from "./git.ts";
import { GitHubError, type GitHub, type PullRequest } from "./github.ts";
import type { Hub } from "./hub.ts";
import { pauseRun } from "./pause.ts";
import { isOffLimits, type PathRules } from "./paths.ts";
import { whyNotEligible, type ChangeSet, type PullRequestMode } from "./pulls.ts";
import { runHelperScript, writeHelperScript, type HelperScript } from "./scripts.ts";

export interface TaskSettings {
  workspace: string;
  tempDirectory: string;
  github: GitHub;
  githubToken: string;
  credentials: Credentials;
  serverUrl: string;
  runId: string;
  runRepository: string;
  changes: ChangeSet | undefined;
  ref: string;
  model: string;
  maxBudgetUsd: number;
  verifyCommand: string;
  branchPrefix: string;
  labels: string[];
  force: boolean;
  author: Identity;
  timeBudgetMinutes: number;
  hub: Hub | undefined;
}

export interface PullRequestText {
  title: string;
  body: string;
  commitMessage: string;
}

export interface ClaudeReport {
  title: string | undefined;
  description: string;
  stoppedEarly: string | undefined;
  errors: string;
  costUsd: number;
  runUrl: string;
}

export interface Helpers {
  verify: string;
  [name: string]: string;
}

export type Delivery = { kind: "new-pull-request" } | { kind: "pull-request"; branch: string; base: string } | { kind: "push"; branch: string; pullRequest: number | undefined };

export const DESCRIPTION_FILE = ".claude-pr.md";
const TITLE_LIMIT = 72;
const SLUG_LIMIT = 50;
const COMMIT_BODY_LIMIT = 4000;

export function commentMarker(task: string): string {
  return `<!-- claude-autofix:${task} -->`;
}

export function parseDescription(markdown: string): { title: string | undefined; body: string } {
  const [first = "", ...rest] = markdown.trim().split("\n");
  const heading = /^#{1,3}\s+(.+?)\s*#*$/.exec(first.trim());
  if (!heading?.[1]) return { title: undefined, body: markdown.trim() };
  return { title: heading[1].replace(/[.`*]+$/g, "").replace(/`/g, "").slice(0, TITLE_LIMIT).trim(), body: rest.join("\n").trim() };
}

export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= SLUG_LIMIT) return slug || "changes";
  const cut = slug.slice(0, SLUG_LIMIT);
  const lastBreak = cut.lastIndexOf("-");
  return (lastBreak > SLUG_LIMIT / 2 ? cut.slice(0, lastBreak) : cut).replace(/-+$/, "");
}

export function commitMessage(type: string, title: string, body: string): string {
  const subject = `${type}: ${/^[A-Z][a-z]/.test(title) ? title.charAt(0).toLowerCase() + title.slice(1) : title}`;
  const trimmed = body.trim().slice(0, COMMIT_BODY_LIMIT);
  return trimmed ? `${subject}\n\n${trimmed}` : subject;
}

export abstract class ClaudeTask<Plan> {
  protected readonly settings: TaskSettings;
  #defaultBranch: string | undefined;

  constructor(settings: TaskSettings) {
    this.settings = settings;
  }

  protected abstract readonly name: string;
  protected abstract plan(): Promise<Plan[] | Plan | undefined>;
  protected abstract prompt(plan: Plan, helpers: Helpers): string;
  protected abstract pathRules(plan: Plan): PathRules;
  protected abstract pullRequest(plan: Plan, report: ClaudeReport): Promise<PullRequestText> | PullRequestText;

  protected helperScripts(_plan: Plan): HelperScript[] {
    return [];
  }

  protected scratchFiles(): string[] {
    return [];
  }

  protected delivery(_plan: Plan): Delivery {
    return { kind: "new-pull-request" };
  }

  protected async begin(_plan: Plan): Promise<void> {}

  protected describe(_plan: Plan): string {
    return "changes";
  }

  protected async finished(_plan: Plan): Promise<void> {}

  protected async delivered(_plan: Plan, _pullUrl: string | undefined): Promise<void> {}

  protected needsClaude(_plan: Plan): boolean {
    return true;
  }

  protected get pushOptions(): Omit<PushOptions, "branch"> {
    return {
      cwd: this.settings.workspace,
      token: this.settings.githubToken,
      serverUrl: this.settings.serverUrl,
      repository: this.settings.github.repository,
    };
  }

  protected get claudeEnabled(): boolean {
    return hasCredentials(this.settings.credentials);
  }

  protected async defaultBranch(): Promise<string> {
    this.#defaultBranch ??= await this.settings.github.defaultBranch();
    return this.#defaultBranch;
  }

  protected async onDefaultBranch(): Promise<boolean> {
    if (this.settings.changes) return false;
    return this.settings.ref === (await this.defaultBranch());
  }

  protected whyChangesSkipped(changes: ChangeSet, authors: string[]): string | undefined {
    const ineligible = whyNotEligible(changes, authors.length ? authors : [this.settings.github.owner]);
    if (ineligible) return ineligible;
    checkoutBranchAt({ ...this.pushOptions, branch: changes.branch, sha: changes.sha });
    if (lastCommitIsBy(this.settings.workspace, this.settings.author)) return "its latest commit is already Claude's";
    return undefined;
  }

  protected changesDelivery(changes: ChangeSet, mode: PullRequestMode): Delivery {
    if (mode === "commit") return { kind: "push", branch: changes.branch, pullRequest: changes.pullRequest };
    return { kind: "pull-request", branch: `${this.settings.branchPrefix}/${changes.pullRequest ? `pr-${changes.pullRequest}` : `branch-${slugify(changes.branch)}`}`, base: changes.branch };
  }

  protected ownPullRequests(state: "open" | "all"): Promise<PullRequest[]> {
    return this.settings.github.pullRequestsFromBranches(`${this.settings.branchPrefix}/`, state);
  }

  protected reportClaudeDisabled(): undefined {
    notice("Claude isn't enabled for this repository. Add a CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) secret and pass it to the action to turn it on.");
    return undefined;
  }

  protected descriptionInstructions(example: string): string {
    return `Write a description of your changes to \`${DESCRIPTION_FILE}\` in the repository root. Its first line must be a title naming what changed, written as \`# <title>\`: imperative, specific, under 60 characters, for example \`# ${example}\`. The title becomes the branch name, the commit message and the pull request title, so don't make it generic.`;
  }

  protected toolRules(helpers: Helpers): string {
    const commands = [...Object.values(helpers), "git diff", "git status", "git log"].map((command) => `\`${command}\``).join(", ");
    return `Bash works only for these commands: ${commands}. Anything else is denied, so create and change files with the Write and Edit tools. One denied command doesn't mean Bash is off; still run the commands above.`;
  }

  protected footer(report: ClaudeReport): string {
    const early = report.stoppedEarly ? `\n\n> Claude stopped early (${report.stoppedEarly}), so this may not cover everything.` : "";
    const verified = this.settings.verifyCommand.trim() ? "verify-command passed." : "No verify-command is set, so nothing was built or tested.";
    const usage = report.costUsd > 0 ? ` Claude usage: $${report.costUsd.toFixed(2)} (API-equivalent).` : "";
    return `${early}\n\n---\n\n${verified} From this [workflow run](${report.runUrl}).${usage}`;
  }

  async run(): Promise<void> {
    await this.deleteClosedBranches();
    const planned = await this.plan();
    const plans = planned === undefined ? [] : Array.isArray(planned) ? planned : [planned];
    if (plans.length === 0) return;
    if (!this.claudeEnabled) return this.reportClaudeDisabled();

    const start = currentCommit(this.settings.workspace);
    const deadline = Date.now() + this.settings.timeBudgetMinutes * 60_000;
    const failures: string[] = [];
    for (const [index, plan] of plans.entries()) {
      if (index > 0) {
        if (Date.now() > deadline) {
          notice(`Stopped after ${index} of ${plans.length} groups to stay within time-budget-minutes. The next run picks up the rest.`);
          break;
        }
        resetTo(this.settings.workspace, start);
      }
      log(`::group::Group ${index + 1} of ${plans.length}: ${this.describe(plan)}`);
      try {
        if ((await this.runUnit(plan)) === "paused") return;
      } catch (error) {
        if (plans.length === 1) throw error;
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${this.describe(plan)}: ${message.split("\n")[0]}`);
        warn(`Group ${index + 1} (${this.describe(plan)}) failed and was skipped: ${message}`);
      } finally {
        log("::endgroup::");
      }
    }
    if (failures.length) throw new ActionFailure(`${failures.length} of ${plans.length} groups failed:\n${failures.join("\n")}`);
  }

  private async runUnit(plan: Plan): Promise<"paused" | "done"> {
    const { workspace, tempDirectory } = this.settings;
    await this.begin(plan);
    const helpers: Helpers = { verify: `bash ${writeHelperScript(tempDirectory, workspace, { name: "verify.sh", body: this.settings.verifyCommand })}` };
    for (const script of this.helperScripts(plan)) helpers[script.name.replace(/\.sh$/, "")] = `bash ${writeHelperScript(tempDirectory, workspace, script)}`;

    const report = this.needsClaude(plan) ? await this.askClaude(plan, helpers) : this.reportWithoutClaude();
    if (!report) return "paused";
    await this.finished(plan);
    this.removeScratchFiles();
    this.dropOffLimitsChanges(plan);

    if (changedFiles(workspace).length === 0) {
      if (report.stoppedEarly) throw new ActionFailure(`Claude stopped (${report.stoppedEarly}) without changing anything: ${report.errors}`);
      log("Nothing was changed.");
      await this.delivered(plan, undefined);
      return "done";
    }

    const text = await this.pullRequest(plan, report);
    const delivery = this.delivery(plan);
    const branch = delivery.kind === "new-pull-request" ? await this.freeBranch(`${this.settings.branchPrefix}/${slugify(text.title)}`) : delivery.branch;
    commitAll(workspace, branch, text.commitMessage, this.settings.author);
    this.verify();
    discardUncommitted(workspace);

    if (delivery.kind === "push") {
      await this.pushToBranch(delivery, text);
      await this.delivered(plan, delivery.pullRequest ? `${this.settings.serverUrl}/${this.settings.github.repository}/pull/${delivery.pullRequest}` : undefined);
      return "done";
    }
    forcePush({ ...this.pushOptions, branch });
    const pull = await this.openPullRequest(branch, delivery.kind === "pull-request" ? delivery.base : await this.defaultBranch(), text);
    setOutput("pull-request-url", pull.html_url);
    setOutput("branch", branch);
    await this.delivered(plan, pull.html_url);
    summary(`- [${text.title}](${pull.html_url})`);
    log(`Pull request: ${pull.html_url}`);
    return "done";
  }

  readonly #usedBranches = new Set<string>();

  private async freeBranch(base: string): Promise<string> {
    const taken = new Set([...this.#usedBranches, ...(await this.settings.github.branchesStartingWith(base)).map((branch) => branch.name)]);
    let candidate = base;
    for (let suffix = 2; taken.has(candidate); suffix++) candidate = `${base}-${suffix}`;
    this.#usedBranches.add(candidate);
    return candidate;
  }

  private async deleteClosedBranches(): Promise<void> {
    const { github } = this.settings;
    try {
      for (const candidate of await github.branchesStartingWith(`${this.settings.branchPrefix}/`)) {
        const [latest] = await github.pullRequests(candidate.name, "all", 1);
        if (latest?.state !== "closed" || latest.head.sha !== candidate.sha) continue;
        await github.deleteBranch(candidate.name);
        log(`Deleted ${candidate.name}: its pull request (#${latest.number}) was ${latest.merged_at ? "merged" : "closed"}.`);
      }
    } catch (error) {
      warn(`Couldn't clean up closed branches: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async askClaude(plan: Plan, helpers: Helpers): Promise<ClaudeReport | undefined> {
    const outcome = await runClaude({
      prompt: this.prompt(plan, helpers),
      cwd: this.settings.workspace,
      model: this.settings.model,
      maxBudgetUsd: this.settings.maxBudgetUsd,
      bashCommands: Object.values(helpers),
      credentials: this.settings.credentials,
      executable: installClaudeCode(join(this.settings.tempDirectory, "claude-code")),
    });
    if (outcome.kind === "limited") {
      await pauseRun(outcome.limit, this.settings.hub);
      return undefined;
    }
    if (!outcome.result) throw new ActionFailure(`Claude stopped unexpectedly: ${outcome.failure ?? "no result"}`);
    return this.report(outcome.result);
  }

  private report(result: SDKResultMessage): ClaudeReport {
    const descriptionPath = join(this.settings.workspace, DESCRIPTION_FILE);
    const written = existsSync(descriptionPath) ? readFileSync(descriptionPath, "utf8").trim() : "";
    const fallback = result.subtype === "success" ? result.result.trim() : "";
    const { title, body } = parseDescription(written || fallback);
    summary(`Claude: ${result.subtype}, ${result.num_turns} turns, $${result.total_cost_usd.toFixed(2)} API-equivalent.`);
    setOutput("claude-cost-usd", result.total_cost_usd.toFixed(4));
    return {
      title,
      description: body || "Claude didn't write a summary.",
      stoppedEarly: result.is_error ? result.subtype : undefined,
      errors: result.subtype === "success" ? "" : result.errors.join("; "),
      costUsd: result.total_cost_usd,
      runUrl: this.runUrl,
    };
  }

  private reportWithoutClaude(): ClaudeReport {
    return { title: undefined, description: "", stoppedEarly: undefined, errors: "", costUsd: 0, runUrl: this.runUrl };
  }

  protected get runUrl(): string {
    return `${this.settings.serverUrl}/${this.settings.runRepository}/actions/runs/${this.settings.runId}`;
  }

  private removeScratchFiles(): void {
    for (const file of [DESCRIPTION_FILE, ...this.scratchFiles()]) rmSync(join(this.settings.workspace, file), { force: true });
  }

  private dropOffLimitsChanges(plan: Plan): void {
    const rules = this.pathRules(plan);
    for (const file of changedFiles(this.settings.workspace)) {
      if (!isOffLimits(file.path, rules)) continue;
      warn(`Dropped Claude's change to ${file.path}: it's outside what this run may change.`);
      restore(file, this.settings.workspace);
    }
  }

  private verify(): void {
    if (!this.settings.verifyCommand.trim()) return;
    log("Running verify-command");
    const result = runHelperScript(join(this.settings.tempDirectory, "verify.sh"));
    untrustedOutput("verify-command output", () => log(result.output));
    if (result.ok) return;
    untrustedOutput("Claude's changes (not pushed)", () => log(git(["show", "--stat", "--patch", "HEAD"], { cwd: this.settings.workspace })));
    throw new ActionFailure("verify-command failed after Claude's changes, so nothing was pushed. The attempted diff is in the log above.");
  }

  private async pushToBranch(delivery: Extract<Delivery, { kind: "push" }>, text: PullRequestText): Promise<void> {
    if (!pushIfUnchanged({ ...this.pushOptions, branch: delivery.branch })) {
      notice(`${delivery.branch} moved while Claude was working, so nothing was pushed. The next run picks up the new commits.`);
      return;
    }
    log(`Pushed Claude's changes to ${delivery.branch}.`);
    if (!delivery.pullRequest) return summary(`Pushed to ${delivery.branch}.\n\n### ${text.title}\n\n${text.body}`);
    await this.settings.github.upsertComment(delivery.pullRequest, commentMarker(this.name), `### ${text.title}\n\n${text.body}`);
    summary(`Pushed to ${delivery.branch} (#${delivery.pullRequest}).`);
  }

  private async openPullRequest(branch: string, base: string, text: PullRequestText): Promise<PullRequest> {
    const { github, labels } = this.settings;
    try {
      const [existing] = await github.pullRequests(branch, "open", 1);
      const pull = existing
        ? await github.updatePullRequest(existing.number, { title: text.title, body: text.body })
        : await github.createPullRequest({ title: text.title, head: branch, base, body: text.body });
      await github.addLabels(pull.number, labels).catch((error: unknown) => warn(`Couldn't add labels: ${error instanceof Error ? error.message : String(error)}`));
      return pull;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 403) {
        throw new ActionFailure(`${error.message}\nPushed ${branch}, but GitHub refused to open the pull request. Turn on Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests", or use a GitHub App token.`);
      }
      throw error;
    }
  }
}
