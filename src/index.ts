import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ActionFailure, booleanInput, eventPayload, fail, input, mask, multilineInput, numberInput, requiredEnv } from "./base/actions.ts";
import { gitHubFromEnvironment } from "./base/github.ts";
import type { TaskSettings } from "./base/task.ts";
import { QualityTask, type PullRequestEvent } from "./tasks/quality.ts";
import { resume } from "./tasks/resume.ts";
import { SecurityTask } from "./tasks/security.ts";
import { SOURCE_EXTENSIONS } from "./tasks/sources.ts";

const CLAUDE_TASKS = {
  security: { branch: "claude/security-fixes", labels: ["security", "automated"], model: "claude-opus-5-5", budget: 5 },
  quality: { branch: "claude/code-quality", labels: ["code-quality", "automated"], model: "claude-sonnet-5-5", budget: 3 },
};

type ClaudeTaskName = keyof typeof CLAUDE_TASKS;

function isClaudeTask(name: string): name is ClaudeTaskName {
  return Object.hasOwn(CLAUDE_TASKS, name);
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
    refName: process.env.GITHUB_REF_NAME ?? "",
    model: input("model", defaults.model),
    maxBudgetUsd: numberInput("max-budget-usd", defaults.budget),
    verifyCommand: input("verify-command"),
    branch: input("branch", defaults.branch),
    labels: input("labels") ? multilineInput("labels") : defaults.labels,
    force: booleanInput("force"),
    resumeWorkflow: input("resume-workflow", "claude-resume.yml"),
  };

  const runner = task === "security" ? securityTask(settings) : qualityTask(settings);
  await runner.run();
}

function securityTask(settings: TaskSettings): SecurityTask {
  return new SecurityTask(settings, {
    semgrepConfig: input("semgrep-config", "p/default p/secrets p/github-actions").split(/\s+/).filter(Boolean),
    semgrepExcludeRules: input("semgrep-exclude-rules").split(/\s+/).filter(Boolean),
    semgrepVersion: input("semgrep-version", "1.180.0"),
    uploadSarif: booleanInput("upload-sarif", true),
    maxFindings: numberInput("max-findings", 20),
    sha: requiredEnv("GITHUB_SHA"),
    ref: requiredEnv("GITHUB_REF"),
  });
}

function qualityTask(settings: TaskSettings): QualityTask {
  const mode = input("pull-request-mode", "commit");
  if (mode !== "commit" && mode !== "pull-request") throw new ActionFailure(`Input pull-request-mode must be commit or pull-request (got "${mode}").`);
  const extensions = input("extensions") ? input("extensions").split(/[\s,]+/).filter(Boolean).map((extension) => extension.replace(/^\./, "").toLowerCase()) : SOURCE_EXTENSIONS;
  return new QualityTask(settings, {
    areas: multilineInput("areas"),
    area: input("area"),
    exclude: multilineInput("exclude"),
    extensions,
    instructions: input("instructions"),
    batchLines: numberInput("batch-lines", 1500),
    pullRequestMode: mode,
    pullRequestAuthors: multilineInput("pull-request-authors"),
    pullRequest: eventPayload<{ pull_request?: PullRequestEvent }>()?.pull_request,
  });
}

main().catch((error: unknown) => {
  if (error instanceof ActionFailure) return fail(error.message);
  fail(`claude-autofix crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
});
