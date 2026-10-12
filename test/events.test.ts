import assert from "node:assert/strict";
import { test } from "node:test";
import { whyIgnored } from "../src/base/events.ts";

const app = "claude-code-scanning[bot]";

test("comments, reviews and other unsupported events never start Claude", () => {
  for (const name of ["issue_comment", "pull_request_review", "pull_request_review_comment", "pull_request_target", "discussion_comment", ""]) {
    assert.ok(whyIgnored({ name, action: "created", sender: "Mackery6969" }, app), name);
  }
});

test("events caused by the app itself are ignored", () => {
  assert.match(whyIgnored({ name: "pull_request", action: "synchronize", sender: app }, app) ?? "", /own work/);
  assert.ok(whyIgnored({ name: "workflow_run", action: "completed", sender: "Claude-Code-Scanning[bot]" }, app));
  assert.ok(whyIgnored({ name: "issues", action: "labeled", sender: app }, app));
});

test("people's events, scheduled runs, resumes and branch cleanup still run", () => {
  assert.equal(whyIgnored({ name: "issues", action: "opened", sender: "ghostbuster3210" }, app), undefined);
  assert.equal(whyIgnored({ name: "workflow_run", action: "completed", sender: "Mackery6969" }, app), undefined);
  assert.equal(whyIgnored({ name: "workflow_dispatch", action: "", sender: app }, app), undefined);
  assert.equal(whyIgnored({ name: "schedule", action: "", sender: "" }, app), undefined);
  assert.equal(whyIgnored({ name: "pull_request", action: "closed", sender: app }, app), undefined);
});
