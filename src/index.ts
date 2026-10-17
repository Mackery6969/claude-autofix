import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ActionFailure, booleanInput, eventPayload, fail, input, mask, multilineInput, notice, numberInput, requiredEnv } from "./base/actions.ts";
import { triggerEvent, whyIgnored } from "./base/events.ts";
import { botIdentity, GITHUB_ACTIONS_BOT } from "./base/git.ts";
import { applyConfig, CONFIG_FILE, readConfig, taskEnabled } from "./base/config.ts";
import { gitHubFromEnvironment, type GitHub } from "./base/github.ts";
import type { Hub, HubJob } from "./base/hub.ts";
import { changeSetFromPullRequest, eventAction, pullRequestFromEvent, type ChangeSet, type PullRequestEvent, type PullRequestMode } from "./base/pulls.ts";
import type { TaskSettings } from "./base/task.ts";
import { parseScannerFilter } from "./tasks/alerts.ts";
import { DEFAULT_ISSUE_LABELS } from "./tasks/issues.ts";
import { QualityTask } from "./tasks/quality.ts";
import { resume } from "./tasks/resume.ts";
import { SecurityTask } from "./tasks/security.ts";
import { SOURCE_EXTENSIONS } from "./tasks/sources.ts";

const CLAUDE_TASKS = {
  security: { branchPrefix: "claude/security", labels: ["security", "automated"], model: "claude-opus-5-5", budget: 5 },
  quality: { branchPrefix: "claude/quality", labels: ["code-quality", "automated"], model: "claude-sonnet-5-5", budget: 3 },
};

type ClaudeTaskName = keyof typeof CLAUDE_TASKS;

interface WorkflowRunEvent {
  workflow_run?: { event: string; head_branch: string | null; head_sha: string; pull_requests?: Array<{ number: number }> };
}

function isClaudeTask(name: string): name is ClaudeTaskName {
  return Object.hasOwn(CLAUDE_TASKS, name);
}

interface Trigger {
  eventName: string;
  action: string;
  sender: string;
  senderType: string;
  branch: string;
  sha: string;
  isTag: boolean;
  pullRequest: PullRequestEvent | undefined;
}

async function triggerFromEnvironment(github: GitHub): Promise<Trigger> {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const event = triggerEvent();
  const run = eventName === "workflow_run" ? eventPayload<WorkflowRunEvent>()?.workflow_run : undefined;
  const runPullRequest = run?.event.startsWith("pull_request") ? run.pull_requests?.[0]?.number : undefined;
  return {
    eventName,
    action: eventAction(),
    sender: event.sender,
    senderType: eventPayload<{ sender?: { type?: string } }>()?.sender?.type ?? "User",
    branch: run ? (run.head_branch ?? "") : (process.env.GITHUB_REF_NAME ?? ""),
    sha: run ? run.head_sha : (process.env.GITHUB_SHA ?? ""),
    isTag: !run && process.env.GITHUB_REF_TYPE === "tag",
    pullRequest: run ? (runPullRequest ? await github.pullRequest(runPullRequest) : undefined) : pullRequestFromEvent(),
  };
}

async function triggerFromHub(github: GitHub, job: HubJob): Promise<Trigger> {
  return {
    eventName: job.pullRequest ? "pull_request" : "workflow_dispatch",
    action: job.pullRequest ? "synchronize" : "",
    sender: job.sender,
    senderType: "User",
    branch: job.ref,
    sha: job.sha,
    isTag: false,
    pullRequest: job.pullRequest ? await github.pullRequest(job.pullRequest) : undefined,
  };
}

async function changeSetFor(github: GitHub, trigger: Trigger): Promise<ChangeSet | undefined> {
  if (trigger.pullRequest) return changeSetFromPullRequest(trigger.pullRequest, github.repository);
  const base = await github.defaultBranch();
  if (!trigger.branch || trigger.branch === base || trigger.isTag) return undefined;
  const [open] = await github.pullRequests(trigger.branch, "open", 1);
  if (open) return changeSetFromPullRequest(await github.pullRequest(open.number), github.repository);
  const sha = trigger.sha || (await github.commitSha(github.repository, trigger.branch));
  return { pullRequest: undefined, branch: trigger.branch, sha, base, author: { login: trigger.sender, type: trigger.senderType }, draft: false, fromFork: false };
}

function hostedJob(task: string): HubJob | undefined {
  const repository = input("repository");
  if (!repository || repository === process.env.GITHUB_REPOSITORY) return undefined;
  const pullRequest = numberInput("pull-request", 0);
  return { repository, task, ref: input("ref"), sha: input("sha"), pullRequest: pullRequest || undefined, sender: input("sender") };
}

function hubFor(job: HubJob | undefined): Hub | undefined {
  const url = input("hub-url");
  const secret = input("hub-secret");
  mask(secret);
  if (!job || !url || !secret) return undefined;
  return { url, secret, job, cursor: input("cursor") };
}

async function main(): Promise<void> {
  const task = input("task");
  if (task !== "resume" && !isClaudeTask(task)) return fail(`Input task must be security, quality or resume (got "${task}").`);

  const githubToken = input("github-token") || process.env.GITHUB_TOKEN || "";
  const prToken = input("pr-token");
  mask(prToken);
  const job = hostedJob(task);
  const github = gitHubFromEnvironment(githubToken, job?.repository);
  const runId = requiredEnv("GITHUB_RUN_ID");
  if (task === "resume") return resume({ github, runId, now: new Date() });

  const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const config = readConfig(workspace);
  if (!taskEnabled(config, task)) return notice(`Nothing to do: ${CONFIG_FILE} turns the ${task} task off.`);
  applyConfig(config);

  const defaults = CLAUDE_TASKS[task];
  const appSlug = input("app-slug");
  const author = appSlug ? botIdentity(appSlug, await github.botUserId(appSlug)) : GITHUB_ACTIONS_BOT;
  if (!job) {
    const ignored = whyIgnored(triggerEvent(), author.name);
    if (ignored) return notice(`Nothing to do: ${ignored}.`);
  }
  const trigger = job ? await triggerFromHub(github, job) : await triggerFromEnvironment(github);
  const closing = trigger.action === "closed" && Boolean(trigger.pullRequest);
  const settings: TaskSettings = {
    workspace,
    tempDirectory: join(process.env.RUNNER_TEMP ?? tmpdir(), "claude-autofix"),
    github,
    githubToken,
    prToken,
    credentials: { oauthToken: input("claude-code-oauth-token"), apiKey: input("anthropic-api-key") },
    serverUrl: process.env.GITHUB_SERVER_URL ?? "https://github.com",
    runId,
    runRepository: process.env.GITHUB_REPOSITORY ?? github.repository,
    eventName: trigger.eventName,
    eventAction: trigger.action,
    pullRequest: trigger.pullRequest,
    changes: closing ? undefined : await changeSetFor(github, trigger),
    refName: trigger.branch,
    triggerBranch: trigger.branch,
    model: input("model", defaults.model),
    maxBudgetUsd: numberInput("max-budget-usd", defaults.budget),
    verifyCommand: input("verify-command"),
    branchPrefix: input("branch-prefix", defaults.branchPrefix).replace(/\/+$/, ""),
    labels: input("labels") ? multilineInput("labels") : defaults.labels,
    force: booleanInput("force"),
    resumeWorkflow: input("resume-workflow", "claude-resume.yml"),
    author,
    canPushWorkflows: Boolean(prToken || appSlug),
    timeBudgetMinutes: numberInput("time-budget-minutes", 300),
    hosted: Boolean(job),
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
