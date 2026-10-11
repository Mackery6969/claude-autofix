import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { applyPins, parseUses, pinnedLine, resolvePins } from "../src/tasks/pins.ts";
import type { Finding } from "../src/tasks/semgrep.ts";

const SHA = "08eba0b27e820071cde6df949e0beb9ba4906955";
const repo = mkdtempSync(join(tmpdir(), "claude-autofix-pins-"));
after(() => rmSync(repo, { recursive: true, force: true }));

const mutableTag = (path: string, line: number): Finding => ({
  check_id: "yaml.github-actions.security.github-actions-mutable-action-tag.github-actions-mutable-action-tag",
  path,
  start: { line },
  end: { line },
  extra: { message: "", severity: "WARNING" },
});

test("parses uses lines and leaves full SHAs, local and docker actions alone", () => {
  assert.deepEqual(parseUses("      - uses: actions/checkout@v7"), { prefix: "      - uses: ", quote: "", repository: "actions/checkout", subpath: "", ref: "v7" });
  assert.equal(parseUses("    uses: github/codeql-action/upload-sarif@v4 # old")?.subpath, "/upload-sarif");
  assert.equal(parseUses(`      - uses: actions/checkout@${SHA}`), undefined);
  assert.equal(parseUses("      - uses: ./"), undefined);
  assert.equal(parseUses("      - uses: docker://alpine:3"), undefined);
});

test("a pinned line keeps the tag as a comment so Dependabot can keep it current", () => {
  const uses = parseUses('      - uses: "actions/setup-node@v7"');
  assert.equal(uses && pinnedLine(uses, SHA), `      - uses: "actions/setup-node@${SHA}" # v7`);
});

test("pins every mutable tag in a workflow, looking each action up once", async () => {
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  const workflow = join(".github", "workflows", "ci.yml").replace(/\\/g, "/");
  writeFileSync(join(repo, workflow), ["jobs:", "  test:", "    steps:", "      - uses: actions/checkout@v7", "      - run: echo hi", "      - uses: actions/checkout@v7", ""].join("\r\n"));
  const lookups: string[] = [];
  const pins = await resolvePins([mutableTag(workflow, 4), mutableTag(workflow, 6)], repo, async (repository, ref) => {
    lookups.push(`${repository}@${ref}`);
    return SHA;
  });
  assert.equal(pins.length, 2);
  assert.deepEqual(lookups, ["actions/checkout@v7"]);

  applyPins(pins, repo);
  const lines = readFileSync(join(repo, workflow), "utf8").split("\r\n");
  assert.equal(lines[3], `      - uses: actions/checkout@${SHA} # v7`);
  assert.equal(lines[5], `      - uses: actions/checkout@${SHA} # v7`);
  assert.equal(lines[4], "      - run: echo hi");
});

test("an action whose tag can't be resolved is left for a human", async () => {
  writeFileSync(join(repo, "other.yml"), "      - uses: someone/private-action@v1\n");
  const pins = await resolvePins([mutableTag("other.yml", 1)], repo, async () => {
    throw new Error("Not Found");
  });
  assert.deepEqual(pins, []);
});
