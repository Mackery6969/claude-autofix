import assert from "node:assert/strict";
import { test } from "node:test";
import { globToRegExp, hubSettings, matchesAny, parseConfig, parseEvery, taskEnabled } from "../src/base/settings.ts";

const hour = 60 * 60_000;

test("intervals read as minutes, hours, days or weeks, and off turns a schedule off", () => {
  assert.equal(parseEvery("30m"), 30 * 60_000);
  assert.equal(parseEvery("6h"), 6 * hour);
  assert.equal(parseEvery("2d"), 48 * hour);
  assert.equal(parseEvery("1w"), 7 * 24 * hour);
  assert.equal(parseEvery("off"), undefined);
  assert.throws(() => parseEvery("5m"), /too often/);
  assert.throws(() => parseEvery("weekly"), /isn't an interval/);
});

test("with no settings every task runs on its default schedule and scans don't follow pushes", () => {
  const settings = hubSettings(new Map());
  assert.deepEqual(settings.tasks, ["security", "fix", "scan", "quality", "conversation"]);
  assert.deepEqual(settings.every, { security: 6 * hour, fix: 6 * hour, scan: 7 * 24 * hour, quality: 7 * 24 * hour });
  assert.equal(settings.scanOnPush, false);
});

test("leaving a task out of tasks turns it off, schedule and all", () => {
  const settings = hubSettings(parseConfig("tasks: [security, scan]\nscan-every: 1d\nscan-on-push: true\nscan-paths:\n  - src/**\n  - \"*.gml\"\n"));
  assert.deepEqual(settings.tasks, ["security", "scan"]);
  assert.deepEqual(settings.every, { security: 6 * hour, fix: undefined, scan: 24 * hour, quality: undefined });
  assert.equal(settings.scanOnPush, true);
  assert.deepEqual(settings.scanPaths, ["src/**", "*.gml"]);
  assert.ok(!taskEnabled(parseConfig("tasks: [security]\n"), "conversation"));
  assert.equal(hubSettings(parseConfig("tasks: [security]\nscan-on-push: true\n")).scanOnPush, false);
});

test("path patterns match folders, extensions anywhere, and single segments", () => {
  assert.ok(matchesAny("src/auth/login.ts", ["src/**"]));
  assert.ok(matchesAny("PizzaTower_GM2/objects/a/Step_0.gml", ["*.gml"]));
  assert.ok(!matchesAny("docs/readme.md", ["src/**", "*.gml"]));
  assert.ok(matchesAny("anything.txt", []));
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/deep/a.ts"));
  assert.ok(globToRegExp("**/migrations/*.sql").test("db/migrations/1.sql"));
  assert.ok(globToRegExp("**/migrations/*.sql").test("migrations/1.sql"));
});
