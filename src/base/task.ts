import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ActionFailure, log, notice, setOutput, summary, untrustedOutput, warn } from "./actions.ts";
import { hasCredentials, installClaudeCode, runClaude, type Credentials } from "./claude.ts";
import { changedFiles, commitAll, discardUncommitted, forcePush, git, pushIfUnchanged, restore, type PushOptions } from "./git.ts";
import { GitHubError, type GitHub, type PullRequest } from "./github.ts";
import { pauseRun } from "./pause.ts";
import { isOffLimits, type PathRules } from "./paths.ts";
import { runHelperScript, writeHelperScript, type HelperScript } from "./scripts.ts";

export interface TaskSettings {
  workspace: string;
  tempDirectory: string;
  github: GitHub;
  githubToken: string;
  prToken: string;
  credentials: Credentials;
  serverUrl: string;
  runId: string;
  eventName: string;
  refName: string;
  model: string;
  maxBudgetUsd: number;
  verifyCommand: string;
  branch: string;
  labels: string[];
  force: boolean;
  resumeWorkflow: string;
}

export interface PullRequestText {
  title: string;
  body: string;
  commitMessage: string;
}

export interface ClaudeReport {
  description: string;
  stoppedEarly: string | undefined;
  costUsd: number;
  runUrl: string;
}

export interface Helpers {
  verify: string;
  [name: string]: string;
}

export type Delivery = { kind: "pull-request"; branch: string; base?: string } | { kind: "push"; branch: string; pullRequest: number };

export const DESCRIPTION_FILE = ".claude-pr.md";
const WORKFLOWS = ".github/workflows";

export abstract class ClaudeTask<Plan> {
  protected readonly settings: TaskSettings;
  #defaultBranch: string | undefined;

  constructor(settings: TaskSettings) {
    this.settings = settings;
  }

  protected abstract readonly name: string;
  protected abstract plan(): Promise<Plan | undefined>;
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
    return { kind: "pull-request", branch: this.settings.branch };
  }

  protected finished(_plan: Plan): void {}

  protected get canEditWorkflows(): boolean {
    return Boolean(this.settings.prToken);
  }

  protected get pushOptions(): Omit<PushOptions, "branch"> {
    return {
      cwd: this.settings.workspace,
      token: this.settings.prToken || this.settings.githubToken,
      serverUrl: this.settings.serverUrl,
      repository: this.settings.github.repository,
    };
  }

  protected async defaultBranch(): Promise<string> {
    this.#defaultBranch ??= await this.settings.github.defaultBranch();
    return this.#defaultBranch;
  }

  protected async onDefaultBranch(): Promise<boolean> {
    if (this.settings.eventName.startsWith("pull_request")) return false;
    return this.settings.refName === (await this.defaultBranch());
  }

  protected get claudeEnabled(): boolean {
    return hasCredentials(this.settings.credentials);
  }

  protected reportClaudeDisabled(): undefined {
    notice("Claude isn't enabled for this repository. Add a CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) secret and pass it to the action to turn it on.");
    return undefined;
  }

  async run(): Promise<void> {
    const plan = await this.plan();
    if (plan === undefined) return;
    if (!this.claudeEnabled) return this.reportClaudeDisabled();

    const { workspace, tempDirectory } = this.settings;
    const helpers: Helpers = { verify: `bash ${writeHelperScript(tempDirectory, workspace, { name: "verify.sh", body: this.settings.verifyCommand })}` };
    for (const script of this.helperScripts(plan)) helpers[script.name.replace(/\.sh$/, "")] = `bash ${writeHelperScript(tempDirectory, workspace, script)}`;

    const outcome = await runClaude({
      prompt: this.prompt(plan, helpers),
      cwd: workspace,
      model: this.settings.model,
      maxBudgetUsd: this.settings.maxBudgetUsd,
      bashCommands: Object.values(helpers),
      credentials: this.settings.credentials,
      executable: installClaudeCode(join(tempDirectory, "claude-code")),
    });

    if (outcome.kind === "limited") {
      await pauseRun(outcome.limit, { github: this.settings.github, runId: this.settings.runId, resumeWorkflow: this.settings.resumeWorkflow });
      return;
    }
    if (!outcome.result) throw new ActionFailure(`Claude stopped unexpectedly: ${outcome.failure ?? "no result"}`);
    this.finished(plan);

    const report = this.report(outcome.result);
    this.removeScratchFiles();
    this.dropOffLimitsChanges(plan);

    if (changedFiles(workspace).length === 0) {
      if (outcome.result.is_error) throw new ActionFailure(`Claude stopped (${outcome.result.subtype}) without changing anything: ${outcome.result.subtype === "success" ? "" : outcome.result.errors.join("; ")}`);
      log("Claude made no changes.");
      return;
    }

    const text = await this.pullRequest(plan, report);
    const delivery = this.delivery(plan);
    commitAll(workspace, delivery.branch, text.commitMessage);
    this.verify();
    discardUncommitted(workspace);

    if (delivery.kind === "push") {
      await this.pushToPullRequest(delivery, text);
      return;
    }
    forcePush({ ...this.pushOptions, branch: delivery.branch });
    const pull = await this.openPullRequest(delivery, text);
    setOutput("pull-request-url", pull.html_url);
    summary(`Pull request: ${pull.html_url}`);
    log(`Pull request: ${pull.html_url}`);
  }

  protected footer(report: ClaudeReport): string {
    const early = report.stoppedEarly ? `\n\n> Claude stopped early (${report.stoppedEarly}), so this may not cover everything.` : "";
    const verified = this.settings.verifyCommand.trim() ? "verify-command passed." : "No verify-command is set, so nothing was built or tested.";
    return `${early}\n\n---\n\n${verified} Opened by this [workflow run](${report.runUrl}). Claude usage: $${report.costUsd.toFixed(2)} (API-equivalent).`;
  }

  private report(result: SDKResultMessage): ClaudeReport {
    const descriptionPath = join(this.settings.workspace, DESCRIPTION_FILE);
    const written = existsSync(descriptionPath) ? readFileSync(descriptionPath, "utf8").trim() : "";
    const fallback = result.subtype === "success" ? result.result.trim() : "";
    summary(`Claude: ${result.subtype}, ${result.num_turns} turns, $${result.total_cost_usd.toFixed(2)} API-equivalent.`);
    setOutput("claude-cost-usd", result.total_cost_usd.toFixed(4));
    return {
      description: written || fallback || "Claude didn't write a summary.",
      stoppedEarly: result.is_error ? result.subtype : undefined,
      costUsd: result.total_cost_usd,
      runUrl: `${this.settings.serverUrl}/${this.settings.github.repository}/actions/runs/${this.settings.runId}`,
    };
  }

  private removeScratchFiles(): void {
    for (const file of [DESCRIPTION_FILE, ...this.scratchFiles()]) rmSync(join(this.settings.workspace, file), { force: true });
  }

  private dropOffLimitsChanges(plan: Plan): void {
    const rules = this.pathRules(plan);
    const excluded = this.canEditWorkflows ? rules.excluded : [...rules.excluded, WORKFLOWS];
    for (const file of changedFiles(this.settings.workspace)) {
      if (!isOffLimits(file.path, { ...rules, excluded })) continue;
      const reason = file.path.startsWith(`${WORKFLOWS}/`) && !this.canEditWorkflows ? "workflow files need a pr-token with workflows permission" : "it's outside what this run may change";
      warn(`Dropped Claude's change to ${file.path}: ${reason}.`);
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

  private async pushToPullRequest(delivery: Extract<Delivery, { kind: "push" }>, text: PullRequestText): Promise<void> {
    if (!pushIfUnchanged({ ...this.pushOptions, branch: delivery.branch })) {
      notice(`${delivery.branch} moved while Claude was working, so nothing was pushed. The next run picks up the new commits.`);
      return;
    }
    await this.settings.github.upsertComment(delivery.pullRequest, `<!-- claude-autofix:${this.name} -->`, `### ${text.title}\n\n${text.body}`);
    log(`Pushed Claude's changes to ${delivery.branch}.`);
    summary(`Pushed to ${delivery.branch} (#${delivery.pullRequest}).`);
  }

  private async openPullRequest(delivery: Extract<Delivery, { kind: "pull-request" }>, text: PullRequestText): Promise<PullRequest> {
    const { github, labels } = this.settings;
    try {
      const [existing] = await github.pullRequests(delivery.branch, "open", 1);
      const pull = existing
        ? await github.updatePullRequest(existing.number, { title: text.title, body: text.body })
        : await github.createPullRequest({ title: text.title, head: delivery.branch, base: delivery.base ?? (await this.defaultBranch()), body: text.body });
      await github.addLabels(pull.number, labels).catch((error: unknown) => warn(`Couldn't add labels: ${error instanceof Error ? error.message : String(error)}`));
      return pull;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 403) {
        throw new ActionFailure(`${error.message}\nPushed ${delivery.branch}, but GitHub refused to open the pull request. Turn on Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests", or pass a pr-token.`);
      }
      throw error;
    }
  }
}
