import assert from "node:assert/strict";
import { test } from "node:test";
import { isInside, isOffLimits, normalizePath } from "../src/base/paths.ts";

test("normalizes the ways people write a folder", () => {
  assert.equal(normalizePath("./site/"), "site");
  assert.equal(normalizePath("site\\src"), "site/src");
  assert.equal(normalizePath("  "), ".");
  assert.equal(normalizePath("."), ".");
});

test("matches a folder and its contents but not a sibling with the same prefix", () => {
  assert.ok(isInside("site/src/auth.ts", "site"));
  assert.ok(isInside("site", "site"));
  assert.ok(!isInside("site-old/index.ts", "site"));
  assert.ok(isInside("anything.txt", "."));
});

test("keeps changes inside the area and outside excluded paths", () => {
  const rules = { area: "dllgenerator", excluded: ["dllgenerator/updater/miniz.c", ".github/workflows"] };
  assert.ok(!isOffLimits("dllgenerator/updater/updater.c", rules));
  assert.ok(isOffLimits("dllgenerator/updater/miniz.c", rules));
  assert.ok(isOffLimits("site/src/index.ts", rules));
  assert.ok(isOffLimits(".github/workflows/security.yml", { area: ".", excluded: [".github/workflows"] }));
});
