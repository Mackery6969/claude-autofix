import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ActionFailure, booleanInput, fail, input, mask, multilineInput, notice, numberInput, requiredEnv } from "./base/actions.ts";
import { applyConfig, CONFIG_FILE, readConfig, taskEnabled } from "./base/config.ts";
import { botIdentity } from "./base/git.ts";
import { gitHubFor, type GitHub } from "./base/github.ts";
import type { Hub, HubJob } from "./base/hub.ts";
import { changeSetFromPullRequest, type ChangeSet, type PullRequestMode } from "./base/pulls.ts";
import type { TaskSettings } from "./base/task.ts";
import { parseScannerFilter } from "./tasks/alerts.ts";
import { DEFAULT_ISSUE_LABELS } from "./tasks/issues.ts";
import { QualityTask } from "./tasks/quality.ts";
import { SecurityTask } from "./tasks/security.ts";
import { SOURCE_EXTENSIONS } from "./tasks/sources.ts";

const CLAUDE_TASKS = {
  security: { branchPrefix: "claude/security", labels: ["security", "automated"], model: "claude-opus-5-5", budget: 5 },
  quality: { branchPrefix: "claude/quality", labels: ["code-quality", "automated"], model: "claude-sonnet-5-5", budget: 3 },
};

type ClaudeTaskName = keyof typeof CLAUDE_TASKS;

function isClaudeTask(name: string): name is ClaudeTaskName {
  return Object.hasOwn(CLAUDE_TASKS, name);
}

function required(name: string): string {
  const value = input(name);
  if (!value) throw new ActionFailure(`Input ${name} is required. Claude Autofix runs from the hub's runner workflow (examples/runner.yml), which passes it.`);
  return value;
}

function jobFromInputs(task: string): HubJob {
  const repository = required("repository");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new ActionFailure(`Input repository must be owner/name (got "${repository}").`);
  const pullRequest = numberInput("pull-request", 0);
  return { repository, task, ref: input("ref"), sha: input("sha"), pullRequest: pullRequest || undefined, sender: input("sender") };
}

function hubFor(job: HubJob): Hub | undefined {
  const url = input("hub-url");
  const secret = input("hub-secret");
  mask(secret);
  if (!url || !secret) return undefined;
  return { url, secret, job, cursor: input("cursor") };
}

async function changeSetFor(github: GitHub, job: HubJob): Promise<ChangeSet | undefined> {
  if (job.pullRequest) return changeSetFromPullRequest(await github.pullRequest(job.pullRequest), github.repository);
  const base = await github.defaultBranch();
  if (!job.ref || job.ref === base) return undefined;
  const [open] = await github.pullRequests(job.ref, "open", 1);
  if (open) return changeSetFromPullRequest(await github.pullRequest(open.number), github.repository);
  const sha = job.sha || (await github.commitSha(github.repository, job.ref));
  return { pullRequest: undefined, branch: job.ref, sha, base, author: { login: job.sender, type: "User" }, draft: false, fromFork: false };
}

async function main(): Promise<void> {
  const task = input("task");
  if (!isClaudeTask(task)) return fail(`Input task must be security or quality (got "${task}").`);

  const job = jobFromInputs(task);
  const githubToken = required("github-token");
  const appSlug = required("app-slug");
  const github = gitHubFor(githubToken, job.repository);

  const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const config = readConfig(workspace);
  if (!taskEnabled(config, task)) return notice(`Nothing to do: ${CONFIG_FILE} turns the ${task} task off.`);
  applyConfig(config);

  const defaults = CLAUDE_TASKS[task];
  const ref = job.ref || (await github.defaultBranch());
  const settings: TaskSettings = {
    workspace,
    tempDirectory: join(process.env.RUNNER_TEMP ?? tmpdir(), "claude-autofix"),
    github,
    githubToken,
    credentials: { oauthToken: input("claude-code-oauth-token"), apiKey: input("anthropic-api-key") },
    serverUrl: process.env.GITHUB_SERVER_URL ?? "https://github.com",
    runId: requiredEnv("GITHUB_RUN_ID"),
    runRepository: process.env.GITHUB_REPOSITORY ?? job.repository,
    changes: await changeSetFor(github, { ...job, ref }),
    ref,
    model: input("model", defaults.model),
    maxBudgetUsd: numberInput("max-budget-usd", defaults.budget),
    verifyCommand: input("verify-command"),
    branchPrefix: input("branch-prefix", defaults.branchPrefix).replace(/\/+$/, ""),
    labels: input("labels") ? multilineInput("labels") : defaults.labels,
    force: booleanInput("force"),
    author: botIdentity(appSlug, await github.botUserId(appSlug)),
    timeBudgetMinutes: numberInput("time-budget-minutes", 300),
    hub: hubFor(job),
  };

  const runner = task === "security" ? securityTask(settings) : qualityTask(settings);
  await runner.run();
}

function pullRequestMode(): PullRequestMode {
  const mode = input("pull-request-mode", "commit");
  if (mode !== "commit" && mode !== "pull-request") throw new ActionFailure(`Input pull-request-mode must be commit or pull-request (got "${mode}").`);
  return mode;
}

function securityTask(settings: TaskSettings): SecurityTask {
  return new SecurityTask(settings, {
    maxFindings: numberInput("max-findings", 10),
    groupingModel: input("grouping-model", "claude-haiku-5-5"),
    scanners: parseScannerFilter(input("code-scanning-tools", "all")),
    handleIssues: booleanInput("issues", true),
    handleDependabot: booleanInput("dependabot-alerts", true),
    issueLabels: input("issue-labels") ? multilineInput("issue-labels") : DEFAULT_ISSUE_LABELS,
    pullRequestMode: pullRequestMode(),
    pullRequestAuthors: multilineInput("pull-request-authors"),
  });
}

function qualityTask(settings: TaskSettings): QualityTask {
  const extensions = input("extensions") ? input("extensions").split(/[\s,]+/).filter(Boolean).map((extension) => extension.replace(/^\./, "").toLowerCase()) : SOURCE_EXTENSIONS;
  return new QualityTask(settings, {
    areas: multilineInput("areas"),
    area: input("area"),
    exclude: multilineInput("exclude"),
    extensions,
    instructions: input("instructions"),
    batchLines: numberInput("batch-lines", 1500),
    pullRequestMode: pullRequestMode(),
    pullRequestAuthors: multilineInput("pull-request-authors"),
  });
}

main().catch((error: unknown) => {
  if (error instanceof ActionFailure) return fail(error.message);
  fail(`claude-autofix crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
});
