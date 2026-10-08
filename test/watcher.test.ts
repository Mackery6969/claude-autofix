import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageLimitWatcher, withoutRunnerSecrets } from "../src/base/claude.ts";

const now = new Date("2026-10-08T03:00:00Z");

const rejection = (resetsAt: number, rateLimitType: string) => ({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType }, uuid: "u", session_id: "s" }) as unknown as SDKMessage;
const limitedReply = (text: string) => ({ type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text }] }, parent_tool_use_id: null, uuid: "u", session_id: "s" }) as unknown as SDKMessage;
const failed = (errors: string[], subtype = "error_during_execution") => ({ type: "result", subtype, is_error: true, errors }) as unknown as SDKResultMessage;
const succeeded = (result: string) => ({ type: "result", subtype: "success", is_error: false, result }) as unknown as SDKResultMessage;

test("uses the reset time from a rejected rate-limit event", () => {
  const watcher = new UsageLimitWatcher();
  watcher.observe(rejection(1791432000, "seven_day"));
  watcher.observe(limitedReply("You've hit your weekly limit"));
  const limit = watcher.limit(failed([]), undefined, now);
  assert.equal(limit?.resetsAt.getTime(), 1791432000 * 1000);
  assert.equal(limit?.type, "seven_day");
});

test("falls back to the message text when there is no event", () => {
  const watcher = new UsageLimitWatcher();
  watcher.observe(limitedReply("You've hit your session limit · resets 11:20pm (America/Chicago)"));
  assert.equal(watcher.limit(failed([]), undefined, now)?.resetsAt.toISOString(), "2026-10-08T04:20:00.000Z");
});

test("a run that finished normally is not a pause, even after a warning event", () => {
  const watcher = new UsageLimitWatcher();
  watcher.observe(rejection(1791432000, "five_hour"));
  assert.equal(watcher.limit(succeeded("Fixed 3 findings, including a missing rate limit."), undefined, now), undefined);
});

test("running out of budget is not a usage limit", () => {
  const watcher = new UsageLimitWatcher();
  assert.equal(watcher.limit(failed(["Reached the usage limit for this budget"], "error_max_budget_usd"), undefined, now), undefined);
});

test("an unrelated failure is not a pause", () => {
  const watcher = new UsageLimitWatcher();
  assert.equal(watcher.limit(failed(["Invalid API key"]), undefined, now), undefined);
});

test("a crashed process that reports the limit still pauses", () => {
  const watcher = new UsageLimitWatcher();
  assert.ok(watcher.limit(undefined, "Claude Code process exited: You've hit your session limit · resets 11:20pm (America/Chicago)", now));
});

test("strips action inputs and runner tokens from the environment Claude gets", () => {
  const environment = withoutRunnerSecrets({ PATH: "/bin", "INPUT_GITHUB-TOKEN": "x", GITHUB_TOKEN: "x", ACTIONS_RUNTIME_TOKEN: "x", CLAUDE_CODE_OAUTH_TOKEN: "x", HOME: "/home/runner" });
  assert.deepEqual(Object.keys(environment).sort(), ["HOME", "PATH"]);
});
