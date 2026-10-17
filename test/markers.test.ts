import assert from "node:assert/strict";
import { test } from "node:test";
import { coverage, handledMarker, RETRY_AFTER_MERGE_MS } from "../src/tasks/markers.ts";

const now = new Date("2026-10-17T12:00:00Z");
const pull = (number: number, keys: string[], mergedAgoMs: number | null) => ({
  number,
  head: {},
  body: handledMarker(keys),
  merged_at: mergedAgoMs === null ? null : new Date(now.getTime() - mergedAgoMs).toISOString(),
});

test("an alert a merged pull request didn't clear gets another try once the scanner has had a day", () => {
  const covered = coverage([pull(5, ["alert-244"], RETRY_AFTER_MERGE_MS + 1)], now);
  assert.ok(!covered.skip.has("alert-244"));
  assert.deepEqual(covered.retry.get("alert-244"), [5]);
});

test("a recent merge, an open or closed pull request, and an escalation still mean leave it", () => {
  assert.ok(coverage([pull(5, ["alert-1"], 60_000)], now).skip.has("alert-1"));
  assert.ok(coverage([{ ...pull(6, ["alert-2"], null) }], now).skip.has("alert-2"));
  assert.ok(coverage([{ number: 7, body: handledMarker(["dependency-3"]) }], now).skip.has("dependency-3"));
  assert.ok(coverage([pull(8, ["alert-4"], RETRY_AFTER_MERGE_MS * 3), pull(9, ["alert-4"], null)], now).skip.has("alert-4"));
});

test("two merged attempts are enough, and issues are never retried this way", () => {
  assert.ok(coverage([pull(5, ["alert-244"], RETRY_AFTER_MERGE_MS * 5), pull(11, ["alert-244"], RETRY_AFTER_MERGE_MS * 2)], now).skip.has("alert-244"));
  assert.ok(coverage([pull(5, ["issue-12"], RETRY_AFTER_MERGE_MS * 5)], now).skip.has("issue-12"));
});
