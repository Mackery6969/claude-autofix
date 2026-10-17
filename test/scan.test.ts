import assert from "node:assert/strict";
import { test } from "node:test";
import { changedLineCount, lapBatches, withinBudget } from "../src/tasks/scan.ts";
import type { SourceFile } from "../src/tasks/sources.ts";

const files = (...sizes: number[]): SourceFile[] => sizes.map((lines, index) => ({ path: `src/${String.fromCharCode(97 + index)}.ts`, lines }));

test("a run takes a few batches from where the lap stopped, and says when the lap is done", () => {
  const all = files(500, 500, 500, 500, 500);
  const first = lapBatches(all, "", 1000, 2);
  assert.deepEqual(first.map((batch) => [batch.files.map((file) => file.path), batch.lapDone]), [[["src/a.ts", "src/b.ts"], false], [["src/c.ts", "src/d.ts"], false]]);
  const second = lapBatches(all, "src/d.ts", 1000, 2);
  assert.deepEqual(second.map((batch) => [batch.files.map((file) => file.path), batch.lapDone]), [[["src/e.ts"], true]]);
});

test("a run never wraps around into a new lap after its first batch", () => {
  assert.deepEqual(lapBatches(files(500, 500), "src/b.ts", 1000, 3).map((batch) => batch.lapDone), [true]);
});

test("push scans count changed lines, take the biggest changes first, and leave the rest out past the limit", () => {
  const changed = [
    { filename: "src/small.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
    { filename: "src/big.ts", status: "modified", changes: 900 },
    { filename: "src/medium.ts", status: "added", changes: 400 },
  ];
  assert.equal(changedLineCount(changed[0]!), 2);
  const { taken, skipped } = withinBudget(changed, 1000);
  assert.deepEqual(taken.map((file) => file.filename), ["src/big.ts", "src/small.ts"]);
  assert.deepEqual(skipped.map((file) => file.filename), ["src/medium.ts"]);
  assert.deepEqual(withinBudget([{ filename: "src/huge.ts", status: "added", changes: 5000 }], 1000).taken.map((file) => file.filename), ["src/huge.ts"]);
});
