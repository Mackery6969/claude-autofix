import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { DependabotAlert, GitHub, PullRequest } from "../src/base/github.ts";
import {
  DEPENDABOT_FILE,
  dependabotPullRequests,
  dependenciesSection,
  dependencyRank,
  dismissDependencies,
  escalationIssue,
  leftToDependabot,
  mentionsPackage,
  needingEscalation,
  readVerdicts,
  toDependencyAlert,
  VERDICTS_FILE,
  writeDependabotFile,
  type DependencyAlert,
} from "../src/tasks/dependencies.ts";
import { applyGrouping, byPriority, groupByRule, groupingPrompt } from "../src/tasks/groups.ts";

let repo = "";
before(() => {
  repo = mkdtempSync(join(tmpdir(), "claude-autofix-dependabot-"));
});
after(() => rmSync(repo, { recursive: true, force: true }));

const raw = (number: number, name = "org.lz4:lz4-java", patched: string | null = null, severity = "high", created = "2026-10-11T23:58:58Z"): DependabotAlert => ({
  number,
  html_url: `https://github.com/o/r/security/dependabot/${number}`,
  created_at: created,
  dependency: { package: { ecosystem: "maven", name }, manifest_path: "settings.gradle", scope: null, relationship: "direct" },
  security_advisory: { ghsa_id: `GHSA-${number}`, cve_id: null, summary: `Problem ${number} | with a pipe`, description: "Details", severity, references: [{ url: "https://example.com/advisory" }] },
  security_vulnerability: { vulnerable_version_range: "<= 1.8.1", first_patched_version: patched ? { identifier: patched } : null, severity },
});

const alert = (...args: Parameters<typeof raw>): DependencyAlert => toDependencyAlert(raw(...args));

const pull = (number: number, login: string, title: string, body = ""): PullRequest => ({ number, html_url: "", state: "open", merged_at: null, title, body, user: { login }, head: { ref: "x", sha: "y", repo: null } });

test("alerts are read into what Claude needs, ranked by severity", () => {
  const lz4 = alert(35);
  assert.equal(lz4.package, "org.lz4:lz4-java");
  assert.equal(lz4.patched, null);
  assert.equal(lz4.scope, "unknown");
  assert.equal(dependencyRank(lz4), 1);
  assert.equal(dependencyRank(alert(1, "a", null, "critical")), 0);
  assert.equal(dependencyRank(alert(2, "a", null, "low")), 3);
});

test("Dependabot keeps what it can fix itself, and Claude gets the rest", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  const pulls = dependabotPullRequests([pull(7, "dependabot[bot]", "Bump lodash from 4.17.20 to 4.17.21"), pull(8, "Mackery6969", "Bump org.lz4:lz4-java manually")]);
  assert.deepEqual(pulls.map((candidate) => candidate.number), [7]);
  assert.match(leftToDependabot(alert(1, "lodash", "4.17.21"), pulls, now) ?? "", /#7/);
  assert.match(leftToDependabot(alert(2, "minimist", "1.2.6", "high", "2026-10-12T11:30:00Z"), pulls, now) ?? "", /an hour/);
  assert.equal(leftToDependabot(alert(3, "minimist", "1.2.6", "high", "2026-10-12T10:00:00Z"), pulls, now), undefined);
  assert.equal(leftToDependabot(alert(35), pulls, now), undefined);
});

test("a Dependabot pull request only counts for the package it names", () => {
  assert.ok(mentionsPackage("Bumps the npm group with 2 updates: [lodash](https://github.com/lodash/lodash) and [x](y)", "lodash"));
  assert.ok(!mentionsPackage("Bump lodash.merge from 4.6.1 to 4.6.2", "lodash"));
  assert.ok(mentionsPackage("Bump org.lz4:lz4-java from 1.8.0 to 1.8.1", "org.lz4:lz4-java"));
  assert.ok(!mentionsPackage("Bump at.yawk.lz4:lz4-java from 1.10.0 to 1.11.4", "lz4-java"));
});

test("Claude's verdicts are read strictly, and a dismissal needs a reason", () => {
  writeFileSync(
    join(repo, VERDICTS_FILE),
    JSON.stringify([
      { alert: 35, verdict: "dismiss", reason: "tolerable_risk", note: "Minecraft  ships its own lz4-java." },
      { alert: 34, verdict: "dismiss", note: "no reason given" },
      { alert: 33, verdict: "escalate", note: "Needs a newer Minecraft." },
      { alert: 33, verdict: "dismiss", reason: "not_used", note: "second verdict for the same alert" },
      { alert: 99, verdict: "fixed", note: "not in this group" },
      { alert: 32, verdict: "ignore", note: "not a verdict" },
    ]),
  );
  assert.deepEqual(readVerdicts(repo, new Set([32, 33, 34, 35])), [
    { alert: 35, verdict: "dismiss", reason: "tolerable_risk", note: "Minecraft ships its own lz4-java." },
    { alert: 33, verdict: "escalate", reason: undefined, note: "Needs a newer Minecraft." },
  ]);
});

test("the alerts file carries the advisory and the versions Claude may use", () => {
  writeDependabotFile(repo, [alert(35, "org.lz4:lz4-java", "1.8.2")]);
  const [entry] = JSON.parse(readFileSync(join(repo, DEPENDABOT_FILE), "utf8"));
  assert.equal(entry.first_patched_version, "1.8.2");
  assert.equal(entry.vulnerable_versions, "<= 1.8.1");
  assert.deepEqual(entry.references, ["https://example.com/advisory"]);
});

test("dismissals go to GitHub, and a refused one is escalated instead", async () => {
  const calls: Array<[number, string, string]> = [];
  const github = {
    dismissDependabotAlert: async (number: number, reason: string, comment: string) => {
      if (number === 34) throw new Error("HTTP 403");
      calls.push([number, reason, comment]);
    },
  } as unknown as GitHub;
  const results = await dismissDependencies(github, [
    { alert: 35, verdict: "dismiss", reason: "tolerable_risk", note: "Ships with Minecraft." },
    { alert: 34, verdict: "dismiss", reason: "not_used", note: "Never called." },
    { alert: 33, verdict: "fixed", reason: undefined, note: "Raised it." },
  ]);
  assert.deepEqual(calls, [[35, "tolerable_risk", "Claude: Ships with Minecraft."]]);
  assert.deepEqual(results.map((result) => result.verdict), ["dismiss", "escalate", "fixed"]);
  assert.match(results[1]?.note ?? "", /would dismiss this as not_used/);
});

test("escalations cover what Claude couldn't settle, in one issue", () => {
  const alerts = [alert(35), alert(34), alert(33), alert(32, "io.netty:netty-codec")];
  const verdicts = [
    { alert: 35, verdict: "dismiss" as const, reason: "tolerable_risk" as const, note: "Ships with Minecraft." },
    { alert: 34, verdict: "escalate" as const, reason: undefined, note: "Needs a newer Minecraft." },
    { alert: 33, verdict: "fixed" as const, reason: undefined, note: "Raised it." },
  ];
  assert.deepEqual(needingEscalation(alerts, verdicts, "https://github.com/o/r/pull/9").map((entry) => entry.number), [34, 32]);
  const escalated = needingEscalation(alerts, verdicts, undefined);
  assert.deepEqual(escalated.map((entry) => entry.number), [34, 33, 32]);
  const issue = escalationIssue(escalated, verdicts, { pullUrl: undefined, runUrl: "https://github.com/o/r/actions/runs/1" });
  assert.equal(issue.title, "Dependabot alerts on org.lz4:lz4-java and 1 more need a decision");
  assert.match(issue.body, /\| \[#34\]\(https:\/\/github\.com\/o\/r\/security\/dependabot\/34\) \| high \| `org\.lz4:lz4-java` in `settings\.gradle` \| none yet \| Problem 34 \/ with a pipe \|/);
  assert.match(issue.body, /- #33: Claude reported a fix, but no change came out of it\. Raised it\./);
  assert.match(issue.body, /- #32: Claude didn't reach a verdict\./);
  assert.match(dependenciesSection(alerts, verdicts), /\[#35\]\([^)]+\) `org\.lz4:lz4-java` \(high, GHSA-35\): Dismissed \(tolerable_risk\)\. Ships with Minecraft\./);
});

test("Dependabot alerts on one package are grouped together and ranked as security work", () => {
  const dependencies = [alert(35), alert(34, "org.lz4:lz4-java", null, "low"), alert(20, "io.netty:netty-codec", "4.1.118", "critical")];
  const prompt = groupingPrompt([], [], 10, dependencies);
  assert.match(prompt, /^dependency-35 \| Dependabot \| maven org\.lz4:lz4-java \| settings\.gradle \| high: Problem 35 \/ with a pipe \(affected <= 1\.8\.1; fixed in no release\)$/m);
  const fallback = byPriority(groupByRule([], [], 10, dependencies));
  assert.deepEqual(fallback.map((group) => [group.label, group.dependencies.map((entry) => entry.number), group.rank]), [
    ["vulnerable io.netty:netty-codec (1 Dependabot alert)", [20], 0],
    ["vulnerable org.lz4:lz4-java (2 Dependabot alerts)", [35, 34], 1],
  ]);
  const grouped = applyGrouping('{"groups": [{"title": "lz4-java from Minecraft", "items": ["dependency-35", "dependency-34"]}]}', [], [], 10, dependencies);
  assert.deepEqual(grouped?.map((group) => [group.label, group.dependencies.map((entry) => entry.number)]), [
    ["lz4-java from Minecraft", [35, 34]],
    ["vulnerable io.netty:netty-codec", [20]],
  ]);
});
