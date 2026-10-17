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
import { ConversationTask } from "./tasks/conversation.ts";
import { QualityTask } from "./tasks/quality.ts";
import { ScanTask } from "./tasks/scan.ts";
import { SecurityTask, type SecurityScope } from "./tasks/security.ts";
import { SOURCE_EXTENSIONS } from "./tasks/sources.ts";

const CLAUDE_TASKS = {
  security: { branchPrefix: "claude/security", labels: ["security", "automated"], model: "claude-opus-5-5", budget: 5, commitType: "fix(security)" },
  fix: { branchPrefix: "claude/fix", labels: ["fix", "automated"], model: "claude-sonnet-5-5", budget: 3, commitType: "fix" },
  scan: { branchPrefix: "claude/scan", labels: ["scan", "automated"], model: "claude-opus-5-5", budget: 3, commitType: "fix" },
  quality: { branchPrefix: "claude/quality", labels: ["code-quality", "automated"], model: "claude-sonnet-5-5", budget: 3, commitType: "refactor" },
};

type ClaudeTaskName = keyof typeof CLAUDE_TASKS;
type TaskName = ClaudeTaskName | "conversation";

function isTask(name: string): name is TaskName {
  return name === "conversation" || Object.hasOwn(CLAUDE_TASKS, name);
}

async function flavorOf(task: TaskName, github: GitHub, job: HubJob): Promise<{ flavor: ClaudeTaskName; commitType: string }> {
  if (task !== "conversation") return { flavor: task, commitType: CLAUDE_TASKS[task].commitType };
  const head = job.pullRequest ? (await github.pullRequest(job.pullRequest)).head.ref : "";
  const flavor = (Object.keys(CLAUDE_TASKS) as ClaudeTaskName[]).find((name) => head.startsWith(`${CLAUDE_TASKS[name].branchPrefix}/`));
  return flavor ? { flavor, commitType: CLAUDE_TASKS[flavor].commitType } : { flavor: "fix", commitType: "fix" };
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
  const issue = numberInput("issue", 0);
  return { repository, task, ref: input("ref"), sha: input("sha"), before: input("before"), pullRequest: pullRequest || undefined, issue: issue || undefined, sender: input("sender") };
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
  if (!isTask(task)) return fail(`Input task must be security, fix, scan, quality or conversation (got "${task}").`);

  const job = jobFromInputs(task);
  const githubToken = required("github-token");
  const appSlug = required("app-slug");
  const github = gitHubFor(githubToken, job.repository);

  const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const config = readConfig(workspace);
  if (!taskEnabled(config, task)) return notice(`Nothing to do: ${CONFIG_FILE} turns the ${task} task off.`);
  applyConfig(config);

  const { flavor, commitType } = await flavorOf(task, github, job);
  const defaults = CLAUDE_TASKS[flavor];
  const ref = task === "conversation" || !job.ref ? await github.defaultBranch() : job.ref;
  const settings: TaskSettings = {
    workspace,
    tempDirectory: join(process.env.RUNNER_TEMP ?? tmpdir(), "claude-autofix"),
    github,
    githubToken,
    credentials: { oauthToken: input("claude-code-oauth-token"), apiKey: input("anthropic-api-key") },
    serverUrl: process.env.GITHUB_SERVER_URL ?? "https://github.com",
    runId: requiredEnv("GITHUB_RUN_ID"),
    runRepository: process.env.GITHUB_REPOSITORY ?? job.repository,
    changes: task === "conversation" ? undefined : await changeSetFor(github, { ...job, ref }),
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

  const runner = task === "conversation" ? conversationTask(settings, job, commitType) : task === "quality" ? qualityTask(settings) : task === "scan" ? scanTask(settings, job) : securityTask(settings, task);
  await runner.run();
}

function pullRequestMode(): PullRequestMode {
  const mode = input("pull-request-mode", "commit");
  if (mode !== "commit" && mode !== "pull-request") throw new ActionFailure(`Input pull-request-mode must be commit or pull-request (got "${mode}").`);
  return mode;
}

function sourceExtensions(): string[] {
  return input("extensions") ? input("extensions").split(/[\s,]+/).filter(Boolean).map((extension) => extension.replace(/^\./, "").toLowerCase()) : SOURCE_EXTENSIONS;
}

function scanTask(settings: TaskSettings, job: HubJob): ScanTask {
  return new ScanTask(settings, {
    paths: multilineInput("scan-paths"),
    maxLines: numberInput("scan-lines", 1500),
    batches: numberInput("scan-batches", 2),
    exclude: multilineInput("exclude"),
    extensions: sourceExtensions(),
    before: job.before ?? "",
    sha: job.sha,
    pullRequestMode: pullRequestMode(),
    pullRequestAuthors: multilineInput("pull-request-authors"),
  });
}

function securityTask(settings: TaskSettings, scope: SecurityScope): SecurityTask {
  const other = scope === "security" ? "fix" : "security";
  return new SecurityTask(settings, {
    scope,
    coveredBy: [CLAUDE_TASKS[other].branchPrefix],
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

function conversationTask(settings: TaskSettings, job: HubJob, commitType: string): ConversationTask {
  const thread = job.pullRequest ?? job.issue;
  if (!thread) throw new ActionFailure("A conversation needs a pull-request or issue number.");
  const prefixes = [CLAUDE_TASKS.security.branchPrefix, CLAUDE_TASKS.quality.branchPrefix, input("branch-prefix")].filter(Boolean).map((prefix) => prefix.replace(/\/+$/, ""));
  return new ConversationTask(settings, {
    thread,
    pullRequestAuthors: multilineInput("pull-request-authors"),
    branchPrefixes: [...new Set(prefixes)],
    commitType,
    scanners: parseScannerFilter(input("code-scanning-tools", "all")),
  });
}

function qualityTask(settings: TaskSettings): QualityTask {
  const extensions = sourceExtensions();
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
