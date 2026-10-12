import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ActionFailure, booleanInput, eventPayload, fail, input, mask, multilineInput, notice, numberInput, requiredEnv } from "./base/actions.ts";
import { triggerEvent, whyIgnored } from "./base/events.ts";
import { botIdentity, GITHUB_ACTIONS_BOT } from "./base/git.ts";
import { gitHubFromEnvironment, type GitHub } from "./base/github.ts";
import { eventAction, pullRequestFromEvent, type PullRequestEvent, type PullRequestMode } from "./base/pulls.ts";
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
  workflow_run?: { event: string; head_branch: string | null; pull_requests?: Array<{ number: number }> };
}

function isClaudeTask(name: string): name is ClaudeTaskName {
  return Object.hasOwn(CLAUDE_TASKS, name);
}

async function pullRequestForRun(github: GitHub): Promise<PullRequestEvent | undefined> {
  if (process.env.GITHUB_EVENT_NAME !== "workflow_run") return pullRequestFromEvent();
  const run = eventPayload<WorkflowRunEvent>()?.workflow_run;
  const number = run?.event.startsWith("pull_request") ? run.pull_requests?.[0]?.number : undefined;
  return number ? github.pullRequest(number) : undefined;
}

function triggerBranch(): string {
  if (process.env.GITHUB_EVENT_NAME === "workflow_run") return eventPayload<WorkflowRunEvent>()?.workflow_run?.head_branch ?? "";
  return process.env.GITHUB_REF_NAME ?? "";
}

async function main(): Promise<void> {
  const task = input("task");
  if (task !== "resume" && !isClaudeTask(task)) return fail(`Input task must be security, quality or resume (got "${task}").`);

  const githubToken = input("github-token") || process.env.GITHUB_TOKEN || "";
  const prToken = input("pr-token");
  mask(prToken);
  const github = gitHubFromEnvironment(githubToken);
  const runId = requiredEnv("GITHUB_RUN_ID");
  if (task === "resume") return resume({ github, runId, now: new Date() });

  const defaults = CLAUDE_TASKS[task];
  const appSlug = input("app-slug");
  const author = appSlug ? botIdentity(appSlug, await github.botUserId(appSlug)) : GITHUB_ACTIONS_BOT;
  const ignored = whyIgnored(triggerEvent(), author.name);
  if (ignored) return notice(`Nothing to do: ${ignored}.`);
  const settings: TaskSettings = {
    workspace: resolve(process.env.GITHUB_WORKSPACE ?? process.cwd()),
    tempDirectory: join(process.env.RUNNER_TEMP ?? tmpdir(), "claude-autofix"),
    github,
    githubToken,
    prToken,
    credentials: { oauthToken: input("claude-code-oauth-token"), apiKey: input("anthropic-api-key") },
    serverUrl: process.env.GITHUB_SERVER_URL ?? "https://github.com",
    runId,
    eventName: process.env.GITHUB_EVENT_NAME ?? "",
    eventAction: eventAction(),
    pullRequest: task === "security" ? await pullRequestForRun(github) : pullRequestFromEvent(),
    refName: process.env.GITHUB_REF_NAME ?? "",
    triggerBranch: triggerBranch(),
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
    pullRequest: settings.pullRequest,
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
    pullRequest: settings.pullRequest,
  });
}

main().catch((error: unknown) => {
  if (error instanceof ActionFailure) return fail(error.message);
  fail(`claude-autofix crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
});
