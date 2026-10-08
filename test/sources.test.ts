import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorMessage, parseCursor } from "../src/tasks/quality.ts";
import { isSourcePath, nextBatch, SOURCE_EXTENSIONS, takeUpTo, type SourceFile } from "../src/tasks/sources.ts";

const scope = { areas: [], exclude: [], extensions: SOURCE_EXTENSIONS };
const files = (...sizes: Array<[string, number]>): SourceFile[] => sizes.map(([path, lines]) => ({ path, lines }));

test("counts code, not assets, lockfiles, vendored or generated files", () => {
  assert.ok(isSourcePath("src/main/java/com/github/elenterius/biomancy/Biomancy.java", scope));
  assert.ok(isSourcePath("site/src/auth.ts", scope));
  assert.ok(!isSourcePath("src/main/resources/assets/biomancy/textures/item/flesh.png", scope));
  assert.ok(!isSourcePath("src/main/resources/assets/biomancy/lang/en_us.json", scope));
  assert.ok(!isSourcePath("site/package-lock.json", scope));
  assert.ok(!isSourcePath("site/node_modules/esbuild/lib/main.js", scope));
  assert.ok(!isSourcePath("src/generated/resources/data.java", scope));
  assert.ok(!isSourcePath("site/src/types.d.ts", scope));
  assert.ok(!isSourcePath("dllgenerator/updater/miniz.c", { ...scope, exclude: ["dllgenerator/updater/miniz.c"] }));
  assert.ok(!isSourcePath("site/src/auth.ts", { ...scope, areas: ["discordbot"] }));
});

test("batches stay under the line budget but always take at least one file", () => {
  const all = files(["a.ts", 600], ["b.ts", 600], ["c.ts", 600], ["huge.ts", 5000]);
  assert.deepEqual(takeUpTo(all, 1500).taken.map((f) => f.path), ["a.ts", "b.ts"]);
  assert.deepEqual(takeUpTo(all.slice(3), 1500).taken.map((f) => f.path), ["huge.ts"]);
});

test("each pass continues after the last file of the previous one and wraps at the end", () => {
  const all = files(["a.ts", 600], ["b.ts", 600], ["c.ts", 600], ["d.ts", 600]);
  const first = nextBatch(all, "", 1500);
  assert.deepEqual(first.files.map((f) => f.path), ["a.ts", "b.ts"]);
  const second = nextBatch(all, first.cursor, 1500);
  assert.deepEqual(second.files.map((f) => f.path), ["c.ts", "d.ts"]);
  const third = nextBatch(all, second.cursor, 1500);
  assert.deepEqual(third.files.map((f) => f.path), ["a.ts", "b.ts"]);
  assert.ok(third.wrapped);
});

test("a cursor pointing at a deleted file resumes at the next file after it", () => {
  const all = files(["a.ts", 10], ["c.ts", 10]);
  assert.deepEqual(nextBatch(all, "b.ts", 5).files.map((f) => f.path), ["c.ts"]);
});

test("cursor markers round-trip, including paths with spaces", () => {
  assert.equal(parseCursor(cursorMessage("Gamemaker Authentication System/site/src/auth.ts")), "Gamemaker Authentication System/site/src/auth.ts");
  assert.equal(parseCursor("unrelated"), "");
});
