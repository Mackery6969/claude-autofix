import assert from "node:assert/strict";
import { test } from "node:test";
import { applyConfig, parseConfig, taskEnabled } from "../src/base/config.ts";

test("reads scalars, lists, inline lists and block text", () => {
  const config = parseConfig(`# Claude Autofix settings
verify-command: "npm ci && npm test" # runs after every change
tasks: [security]
exclude:
  - vendor
  - 'generated/protos'
instructions: |
  Prefer early returns.
    Keep this indent.

batch-lines: 800
`);
  assert.equal(config.get("verify-command"), "npm ci && npm test");
  assert.equal(config.get("exclude"), "vendor\ngenerated/protos");
  assert.equal(config.get("instructions"), "Prefer early returns.\n  Keep this indent.");
  assert.equal(config.get("batch-lines"), "800");
  assert.ok(taskEnabled(config, "security"));
  assert.ok(!taskEnabled(config, "quality"));
});

test("folded text joins into one line and a # inside quotes is kept", () => {
  const config = parseConfig(`instructions: >
  One line
  after another.
labels: "fix #1, automated"
`);
  assert.equal(config.get("instructions"), "One line after another.");
  assert.equal(config.get("labels"), "fix #1, automated");
});

test("no tasks key means every task runs", () => {
  assert.ok(taskEnabled(parseConfig("model: claude-opus-5-5\n"), "quality"));
});

test("refuses keys that would hand over credentials or change the task", () => {
  assert.throws(() => parseConfig("claude-code-oauth-token: x\n"), /can't be set here/);
  assert.throws(() => parseConfig("hub-url: https://example.com\n"), /can't be set here/);
  assert.throws(() => parseConfig("task: resume\n"), /can't be set here/);
  assert.throws(() => parseConfig("  indented: nope\n"), /isn't "key: value"/);
});

test("settings become the action's inputs", () => {
  const environment: NodeJS.ProcessEnv = {};
  applyConfig(parseConfig("verify-command: make test\nmax-findings: 4\n"), environment);
  assert.deepEqual(environment, { "INPUT_VERIFY-COMMAND": "make test", "INPUT_MAX-FINDINGS": "4" });
});
