import { query, type SDKMessage, type SDKRateLimitInfo, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ActionFailure, log, startUntrustedOutput } from "./actions.ts";
import { limitFromText, mentionsUsageLimit, type LimitType, type UsageLimit } from "./limits.ts";

declare const CLAUDE_AGENT_SDK_VERSION: string;

export interface Credentials {
  oauthToken: string;
  apiKey: string;
}

export interface ClaudeRun {
  prompt: string;
  cwd: string;
  model: string;
  maxBudgetUsd: number;
  bashCommands: string[];
  credentials: Credentials;
  executable: string;
}

export type ClaudeOutcome =
  | { kind: "finished"; result: SDKResultMessage | undefined; failure: string | undefined }
  | { kind: "limited"; limit: UsageLimit };

const FILE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];
const READ_ONLY_GIT = ["Bash(git diff:*)", "Bash(git status:*)", "Bash(git log:*)"];
const PROTECTED_PATHS = ["Read(./.git/**)", "Edit(./.git/**)", "Write(./.git/**)"];
const RUNNER_SECRETS = /^(INPUT_.*|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_RUNTIME_URL|ACTIONS_ID_TOKEN_REQUEST_TOKEN|ACTIONS_ID_TOKEN_REQUEST_URL|ACTIONS_CACHE_URL|ACTIONS_RESULTS_URL|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)$/;

export function hasCredentials(credentials: Credentials): boolean {
  return Boolean(credentials.oauthToken || credentials.apiKey);
}

export function withoutRunnerSecrets(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined && !RUNNER_SECRETS.test(entry[0])));
}

export function installClaudeCode(directory: string): string {
  if (process.platform === "win32") throw new ActionFailure("Claude Autofix needs a Linux or macOS runner, such as ubuntu-latest.");
  const platform = `${process.platform}-${process.arch}`;
  const packageName = `@anthropic-ai/claude-agent-sdk-${platform}`;
  const executable = join(directory, "node_modules", ...packageName.split("/"), "claude");
  if (existsSync(executable)) return executable;

  log(`Installing Claude Code (${packageName}@${CLAUDE_AGENT_SDK_VERSION})`);
  const result = spawnSync("npm", ["install", "--no-save", "--no-audit", "--no-fund", "--loglevel=error", "--prefix", directory, `${packageName}@${CLAUDE_AGENT_SDK_VERSION}`], {
    stdio: "inherit",
    env: withoutRunnerSecrets(),
  });
  if (result.status !== 0 || !existsSync(executable)) throw new ActionFailure(`Couldn't install Claude Code for ${platform}. Use an x64 or arm64 runner.`);
  return executable;
}

export async function runClaude(run: ClaudeRun): Promise<ClaudeOutcome> {
  const watcher = new UsageLimitWatcher();
  let result: SDKResultMessage | undefined;
  let failure: string | undefined;

  const endOutput = startUntrustedOutput("Claude");
  try {
    const messages = query({
      prompt: run.prompt,
      options: {
        cwd: run.cwd,
        model: run.model,
        maxBudgetUsd: run.maxBudgetUsd,
        permissionMode: "dontAsk",
        tools: [...FILE_TOOLS, "Bash"],
        allowedTools: [...FILE_TOOLS, ...READ_ONLY_GIT, ...run.bashCommands.map((command) => `Bash(${command}:*)`)],
        disallowedTools: PROTECTED_PATHS,
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        pathToClaudeCodeExecutable: run.executable,
        env: claudeEnvironment(run.credentials),
        stderr: (data) => process.stderr.write(data),
      },
    });
    for await (const message of messages) {
      watcher.observe(message);
      showProgress(message);
      if (message.type === "result") result = message;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    endOutput();
  }

  const limit = watcher.limit(result, failure, new Date());
  return limit ? { kind: "limited", limit } : { kind: "finished", result, failure };
}

function claudeEnvironment(credentials: Credentials): Record<string, string> {
  return {
    ...withoutRunnerSecrets(),
    ...(credentials.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: credentials.oauthToken } : { ANTHROPIC_API_KEY: credentials.apiKey }),
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "claude-autofix",
  };
}

export class UsageLimitWatcher {
  #rejection: SDKRateLimitInfo | undefined;
  #limitedReply = false;
  #texts: string[] = [];

  observe(message: SDKMessage): void {
    if (message.type === "rate_limit_event" && message.rate_limit_info.status === "rejected") this.#rejection = message.rate_limit_info;
    if (message.type === "assistant" && message.error) {
      if (message.error === "rate_limit") this.#limitedReply = true;
      this.#texts.push(...textBlocks(message.message.content));
    }
  }

  limit(result: SDKResultMessage | undefined, failure: string | undefined, now: Date): UsageLimit | undefined {
    const ended = !result || result.is_error || this.#limitedReply;
    if (!ended) return undefined;
    if (result?.subtype === "error_max_budget_usd") return undefined;

    const resultTexts = result ? (result.subtype === "success" ? [result.result] : result.errors) : [];
    const texts = [...this.#texts, ...resultTexts, failure ?? ""];

    const mentioned = texts.some(mentionsUsageLimit);
    if (!this.#limitedReply && !mentioned && !(this.#rejection && result?.is_error)) return undefined;

    if (this.#rejection?.resetsAt) return { resetsAt: new Date(this.#rejection.resetsAt * 1000), type: (this.#rejection.rateLimitType ?? "unknown") as LimitType };
    return limitFromText(texts.filter(mentionsUsageLimit).join("\n") || texts.join("\n"), now);
  }
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: { type?: string; text?: unknown }) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : []));
}

function showProgress(message: SDKMessage): void {
  if (message.type !== "assistant") return;
  const content = message.message.content as Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
  for (const block of content) {
    if (block.type === "text" && block.text) log(block.text);
    if (block.type === "tool_use") log(`→ ${block.name} ${toolTarget(block.input)}`);
  }
}

function toolTarget(toolInput: Record<string, unknown> | undefined): string {
  const target = toolInput?.file_path ?? toolInput?.path ?? toolInput?.pattern ?? toolInput?.command ?? "";
  return String(target).slice(0, 200);
}
