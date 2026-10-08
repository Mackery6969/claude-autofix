import assert from "node:assert/strict";
import { test } from "node:test";
import { limitFromText, mentionsUsageLimit, resetTimeFromText } from "../src/base/limits.ts";

const evening = new Date("2026-10-08T03:00:00Z");

test("reads the session-limit message Claude shows", () => {
  const reset = resetTimeFromText("You've hit your session limit · resets 11:20pm (America/Chicago)", evening);
  assert.equal(reset?.toISOString(), "2026-10-08T04:20:00.000Z");
});

test("rolls a time that already passed today over to tomorrow", () => {
  const reset = resetTimeFromText("You've hit your session limit · resets 9pm (America/Chicago)", evening);
  assert.equal(reset?.toISOString(), "2026-10-09T02:00:00.000Z");
});

test("reads a weekly reset with a date", () => {
  const reset = resetTimeFromText("You've hit your weekly limit · resets Oct 12, 5pm (America/Chicago)", evening);
  assert.equal(reset?.toISOString(), "2026-10-12T22:00:00.000Z");
});

test("reads the older pipe-and-epoch format", () => {
  const reset = resetTimeFromText("Claude AI usage limit reached|1791432000", evening);
  assert.equal(reset?.getTime(), 1791432000 * 1000);
});

test("treats a reset without a time zone as UTC", () => {
  const reset = resetTimeFromText("limit reached, resets 4:30am", evening);
  assert.equal(reset?.toISOString(), "2026-10-08T04:30:00.000Z");
});

test("falls back to an hour from now when no reset time is given", () => {
  const limit = limitFromText("You've hit your limit", evening);
  assert.equal(limit.resetsAt.getTime() - evening.getTime(), 60 * 60 * 1000);
});

test("classifies limit types from the message", () => {
  assert.equal(limitFromText("You've hit your session limit · resets 11:20pm", evening).type, "five_hour");
  assert.equal(limitFromText("You've hit your weekly limit · resets Oct 12, 5pm", evening).type, "seven_day");
});

test("recognises usage-limit wording and ignores ordinary text", () => {
  assert.ok(mentionsUsageLimit("You've hit your session limit · resets 11:20pm"));
  assert.ok(mentionsUsageLimit("Claude AI usage limit reached|1791432000"));
  assert.ok(!mentionsUsageLimit("Added rate limiting to the login endpoint."));
});
