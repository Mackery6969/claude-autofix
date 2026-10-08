import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowRun } from "../src/base/github.ts";
import { parsePauseMessage, pauseMessage, type Pause } from "../src/base/pause.ts";
import { findPause, runsByWorkflow } from "../src/tasks/resume.ts";

const run = (id: number, workflow_id: number, created_at: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  workflow_id,
  name: `workflow ${workflow_id}`,
  event: "schedule",
  status: "completed",
  conclusion: "cancelled",
  head_branch: "main",
  created_at,
  html_url: "",
  ...overrides,
});

const pause: Pause = { resumeAt: new Date("2026-10-08T04:22:00Z"), limit: "five_hour" };
const pausedRuns = (...ids: number[]) => async (candidate: WorkflowRun) => (ids.includes(candidate.id) ? pause : undefined);

test("pause markers round-trip", () => {
  assert.deepEqual(parsePauseMessage(pauseMessage(pause)), pause);
  assert.equal(parsePauseMessage("something else"), undefined);
});

test("groups default-branch runs per workflow and pull request runs per branch, newest first", () => {
  const runs = [
    run(1, 10, "2026-10-07T01:00:00Z"),
    run(2, 10, "2026-10-07T02:00:00Z"),
    run(3, 10, "2026-10-07T03:00:00Z", { event: "pull_request", head_branch: "feature" }),
    run(4, 20, "2026-10-07T01:00:00Z", { head_branch: "feature" }),
    run(5, 30, "2026-10-07T01:00:00Z"),
    run(6, 99, "2026-10-07T05:00:00Z"),
  ];
  const groups = runsByWorkflow(runs, "main", 99).map((group) => ({ pullRequest: group.pullRequest, ids: group.runs.map((r) => r.id) }));
  assert.deepEqual(groups, [
    { pullRequest: false, ids: [2, 1] },
    { pullRequest: true, ids: [3] },
    { pullRequest: false, ids: [5] },
  ]);
});

test("finds a pause behind runs that were cancelled for other reasons", async () => {
  const runs = [run(3, 10, "2026-10-07T03:00:00Z"), run(2, 10, "2026-10-07T02:00:00Z"), run(1, 10, "2026-10-07T01:00:00Z")];
  assert.equal((await findPause(runs, pausedRuns(2)))?.run.id, 2);
});

test("a run that finished after the pause means it was already picked up", async () => {
  const runs = [run(3, 10, "2026-10-07T03:00:00Z", { conclusion: "success" }), run(2, 10, "2026-10-07T02:00:00Z")];
  assert.equal(await findPause(runs, pausedRuns(2)), undefined);
});

test("a run still in progress is left alone", async () => {
  const runs = [run(3, 10, "2026-10-07T03:00:00Z", { status: "in_progress", conclusion: null }), run(2, 10, "2026-10-07T02:00:00Z")];
  assert.equal(await findPause(runs, pausedRuns(2)), undefined);
});

test("a paused run that couldn't cancel itself still counts", async () => {
  const runs = [run(2, 10, "2026-10-07T02:00:00Z", { conclusion: "success" })];
  assert.equal((await findPause(runs, pausedRuns(2)))?.run.id, 2);
});
