import assert from "node:assert/strict";
import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { sign } from "../src/base/hub.ts";
import { appJwt, base64Url, pkcs8FromPem } from "../worker/src/github.ts";
import { ACTIONS_ISSUER, HUB_AUDIENCE, reportKey, TokenError, verifyActionsToken, type SigningKey } from "../worker/src/oidc.ts";
import { contentHash, dispatchLabel, gitBlobSha, SHARED_WORKFLOW, workflowFiles } from "../worker/src/workflow.ts";
import { ALERT_SETTLE_MS, CHECKS_SETTLE_MS, CONVERSATION_SETTLE_MS, DEPENDABOT_GRACE_MS, effectsOf, jobKey, mergeJobs, type Job, type WebhookPayload } from "../worker/src/routing.ts";
import { hubSettings, parseConfig, TASKS } from "../src/base/settings.ts";
import { runnerWorkflows } from "../scripts/hub-deploy.ts";
import { dueJobs, newRecord, scheduledWork } from "../worker/src/schedule.ts";
import { verifySignature } from "../worker/src/signatures.ts";
import { State, type KeyValueStore } from "../worker/src/state.ts";

const now = Date.parse("2026-10-16T12:00:00Z");
const context = { appSlug: "claude-autofix", ignored: ["Mackery6969/claude-autofix-runner", "Mackery6969/Claude-Autofix"], now };
const repository = { full_name: "Mackery6969/game", default_branch: "main" };
const payload = (overrides: WebhookPayload): WebhookPayload => ({ installation: { id: 7 }, repository, sender: { login: "Mackery6969", type: "User" }, ...overrides });
const enqueued = (event: string, body: WebhookPayload) => effectsOf(event, body, context).flatMap((effect) => (effect.kind === "enqueue" ? [effect.job] : []));

const job = (overrides: Partial<Job> = {}): Job => ({ repository: "Mackery6969/game", installation: 7, task: "security", ref: "main", sha: "", pullRequest: undefined, sender: "", due: now, ...overrides });

test("a code scanning alert on the default branch queues a security sweep once the scanner settles", () => {
  const [queued] = enqueued("code_scanning_alert", payload({ action: "created", ref: "refs/heads/main", commit_oid: "abc", alert: { rule: { security_severity_level: "medium" } } }));
  assert.equal(queued?.task, "security");
  assert.equal(queued?.ref, "main");
  assert.equal(queued?.due, now + ALERT_SETTLE_MS);
});

test("alerts on a branch or pull request queue work on just those changes", () => {
  const [branch] = enqueued("code_scanning_alert", payload({ action: "appeared_in_branch", ref: "refs/heads/feature/login", commit_oid: "def" }));
  assert.deepEqual([branch?.ref, branch?.sha, branch?.pullRequest], ["feature/login", "def", undefined]);
  const [pull] = enqueued("code_scanning_alert", payload({ action: "created", ref: "refs/pull/16/merge", commit_oid: "123", alert: { rule: { security_severity_level: "high" } } }));
  assert.equal(pull?.pullRequest, 16);
  assert.equal(jobKey(pull ?? job()), "job:Mackery6969/game|security|pr-16");
  assert.deepEqual(enqueued("code_scanning_alert", payload({ action: "created", ref: "refs/heads/claude/security/x" })), []);
  assert.deepEqual(enqueued("code_scanning_alert", payload({ action: "closed_by_user", ref: "refs/heads/main" })), []);
});

test("issues and Dependabot alerts queue the default-branch sweep, Dependabot after its own grace hour", () => {
  assert.equal(enqueued("issues", payload({ action: "opened" }))[0]?.ref, "main");
  assert.deepEqual(enqueued("issues", payload({ action: "opened", sender: { login: "renovate[bot]", type: "Bot" } })), []);
  assert.equal(enqueued("dependabot_alert", payload({ action: "created" }))[0]?.due, now + DEPENDABOT_GRACE_MS);
});

test("your pull requests get a quality pass; drafts too; bots, forks and Claude's own don't", () => {
  const pull = (overrides: Partial<NonNullable<WebhookPayload["pull_request"]>> = {}) => ({ number: 4, user: { login: "Mackery6969", type: "User" }, head: { ref: "feature", sha: "abc", repo: { full_name: "Mackery6969/game" } }, ...overrides });
  const [quality] = enqueued("pull_request", payload({ action: "opened", pull_request: pull() }));
  assert.deepEqual([quality?.task, quality?.pullRequest, quality?.sender], ["quality", 4, "Mackery6969"]);
  assert.deepEqual(enqueued("pull_request", payload({ action: "opened", pull_request: pull({ draft: true }) })).map((entry) => entry.task), ["quality"]);
  assert.deepEqual(enqueued("pull_request", payload({ action: "ready_for_review", pull_request: pull() })), []);
  const reopened = enqueued("pull_request", payload({ action: "reopened", pull_request: pull() }));
  assert.deepEqual(reopened.map((entry) => `${entry.task}:${entry.pullRequest}`), ["quality:4", "security:4"]);
  assert.equal(reopened[1]?.due, now + ALERT_SETTLE_MS);
  assert.deepEqual(enqueued("pull_request", payload({ action: "opened", pull_request: pull({ head: { ref: "x", sha: "a", repo: { full_name: "someone/game" } } }) })), []);
  assert.deepEqual(enqueued("pull_request", payload({ action: "synchronize", pull_request: pull() })), []);
  assert.deepEqual(enqueued("pull_request", payload({ action: "opened", pull_request: pull(), sender: { login: "claude-autofix[bot]", type: "Bot" } })), []);
});

test("comments become conversations, but never Claude's own or a bot's", () => {
  const [onIssue] = enqueued("issue_comment", payload({ action: "created", issue: { number: 12 }, comment: { user: { login: "stranger", type: "User" } } }));
  assert.deepEqual([onIssue?.task, onIssue?.issue, onIssue?.pullRequest, onIssue?.due], ["conversation", 12, undefined, now + CONVERSATION_SETTLE_MS]);
  const [onPull] = enqueued("issue_comment", payload({ action: "created", issue: { number: 9, pull_request: {} }, comment: { user: { login: "Mackery6969", type: "User" } } }));
  assert.deepEqual([onPull?.pullRequest, onPull?.issue], [9, undefined]);
  assert.equal(jobKey(onPull ?? job()), "job:Mackery6969/game|conversation|pr-9");
  assert.deepEqual(enqueued("issue_comment", payload({ action: "created", issue: { number: 9 }, comment: { user: { login: "claude-autofix[bot]", type: "Bot" } }, sender: { login: "claude-autofix[bot]", type: "Bot" } })), []);
  assert.deepEqual(enqueued("issue_comment", payload({ action: "created", issue: { number: 9 }, comment: { user: { login: "codecov[bot]", type: "Bot" } }, sender: { login: "codecov[bot]", type: "Bot" } })), []);
  assert.deepEqual(enqueued("issue_comment", payload({ action: "edited", issue: { number: 9 }, comment: { user: { login: "Mackery6969" } } })), []);
});

test("reviews on Claude's pull requests become conversations; empty approvals and other pull requests don't", () => {
  const head = (ref: string) => ({ number: 9, user: { login: "claude-autofix[bot]", type: "Bot" }, head: { ref, sha: "abc", repo: repository } });
  const review = (state: string, body: string | null, ref = "claude/quality/x") => enqueued("pull_request_review", payload({ action: "submitted", pull_request: head(ref), review: { user: { login: "Mackery6969", type: "User" }, state, body } }));
  assert.equal(review("commented", "Rename this.")[0]?.pullRequest, 9);
  assert.equal(review("changes_requested", null)[0]?.task, "conversation");
  assert.deepEqual(review("approved", ""), []);
  assert.deepEqual(review("commented", "Rename this.", "feature").map((entry) => `${entry.ref}:${entry.mentioned}`), [":false"]);
  const [inline] = enqueued("pull_request_review_comment", payload({ action: "created", pull_request: head("claude/security/y"), comment: { user: { login: "Mackery6969", type: "User" } } }));
  assert.equal(inline?.sender, "Mackery6969");
});

test("a failed run on Claude's branch, even one its own push started, becomes a conversation on its pull request", () => {
  const run = (head_branch: string) => payload({ action: "completed", sender: { login: "claude-autofix[bot]", type: "Bot" }, workflow_run: { conclusion: "failure", head_branch, head_sha: "abc", pull_requests: [{ number: 9 }], head_repository: repository } });
  const [failed] = enqueued("workflow_run", run("claude/quality/x"));
  assert.deepEqual([failed?.task, failed?.pullRequest, failed?.due], ["conversation", 9, now + CHECKS_SETTLE_MS]);
  assert.deepEqual(enqueued("workflow_run", run("feature")), []);
  assert.deepEqual(enqueued("workflow_run", payload({ action: "completed", workflow_run: { conclusion: "success", head_branch: "claude/quality/x", head_sha: "abc", pull_requests: [{ number: 9 }] } })), []);
});

test("mentioning the app anywhere asks it to join; whether it does is checked against the thread", () => {
  const user = { login: "Mackery6969", type: "User" };
  const [comment] = enqueued("issue_comment", payload({ action: "created", issue: { number: 3, pull_request: {} }, comment: { user, body: "@claude-autofix please review" } }));
  assert.deepEqual([comment?.task, comment?.pullRequest, comment?.mentioned], ["conversation", 3, true]);
  const [plain] = enqueued("issue_comment", payload({ action: "created", issue: { number: 3 }, comment: { user, body: "no mention here" } }));
  assert.equal(plain?.mentioned, false);
  const opened = enqueued("issues", payload({ action: "opened", issue: { number: 8, body: "@claude-autofix why does this crash?" } }));
  assert.deepEqual(opened.map((entry) => `${entry.task}:${entry.issue ?? ""}:${entry.mentioned ?? ""}`), ["fix::", "conversation:8:true"]);
  const pull = { number: 5, user, body: "Adds X. @claude-autofix take a look", head: { ref: "feature", sha: "abc", repo: repository } };
  assert.ok(enqueued("pull_request", payload({ action: "opened", pull_request: pull })).some((entry) => entry.task === "conversation" && entry.pullRequest === 5 && entry.mentioned));
  const [review] = enqueued("pull_request_review_comment", payload({ action: "created", pull_request: { ...pull, body: "" }, comment: { user, body: "@claude-autofix is this safe?" } }));
  assert.deepEqual([review?.task, review?.ref, review?.mentioned], ["conversation", "", true]);
});

test("conversations are dispatched ahead of security, and security ahead of quality", () => {
  const order = dueJobs([job({ task: "quality", due: now - 30 }), job({ task: "security", due: now - 20, ref: "s" }), job({ task: "conversation", pullRequest: 9, due: now - 10 })], now, 3);
  assert.deepEqual(order.map((entry) => entry.task), ["conversation", "security", "quality"]);
});

test("pull requests from official Claude branches don't get a quality pass", () => {
  const pull = { number: 10, user: { login: "Mackery6969", type: "User" }, head: { ref: "claude/hopeful-feynman-dv9xif", sha: "abc", repo: repository } };
  for (const action of ["opened", "reopened"]) assert.deepEqual(enqueued("pull_request", payload({ action, pull_request: pull })), []);
  assert.ok(enqueued("pull_request", payload({ action: "opened", pull_request: { ...pull, head: { ...pull.head, ref: "feature/login" } } })).some((entry) => entry.task === "quality"));
});

test("closing one of Claude's pull requests deletes its branch", () => {
  const effects = effectsOf("pull_request", payload({ action: "closed", pull_request: { number: 9, user: { login: "claude-autofix[bot]", type: "Bot" }, head: { ref: "claude/quality/tidy", sha: "abc", repo: repository } } }), context);
  assert.ok(effects.some((effect) => effect.kind === "delete-branch" && effect.branch === "claude/quality/tidy" && effect.sha === "abc"));
});

test("closing a claude/ pull request another app or person opened leaves its branch alone", () => {
  for (const user of [{ login: "claude[bot]", type: "Bot" }, { login: "someone", type: "User" }]) {
    const effects = effectsOf("pull_request", payload({ action: "closed", pull_request: { number: 9, user, head: { ref: "claude/hopeful-feynman-dv9xif", sha: "abc", repo: repository } } }), context);
    assert.ok(!effects.some((effect) => effect.kind === "delete-branch"));
  }
});

test("the app's own events, the runner and other installations' events don't queue work", () => {
  assert.deepEqual(enqueued("issues", payload({ action: "opened", sender: { login: "Claude-Autofix[bot]", type: "Bot" } })), []);
  assert.deepEqual(effectsOf("issues", payload({ action: "opened", repository: { full_name: "Mackery6969/claude-autofix-runner", default_branch: "main" } }), context), []);
  assert.deepEqual(effectsOf("issues", payload({ action: "opened", repository: { full_name: "mackery6969/claude-autofix", default_branch: "main" } }), context), []);
  assert.deepEqual(effectsOf("issues", { action: "opened", repository }, context), []);
});

test("installing on repositories registers them, except the runner and the action's own repository", () => {
  const [effect] = effectsOf("installation", { action: "created", installation: { id: 7 }, repositories: [{ full_name: "Mackery6969/game" }, { full_name: "Mackery6969/claude-autofix-runner" }, { full_name: "Mackery6969/Claude-Autofix" }] }, context);
  assert.equal(effect?.kind, "register");
  assert.deepEqual(effect?.kind === "register" ? effect.repositories.map((entry) => entry.repository) : [], ["Mackery6969/game"]);
});

test("repeated events for the same work merge into one job that keeps the earliest time", () => {
  const merged = mergeJobs(job({ due: now + 1000, sha: "old" }), job({ due: now + 5000, sha: "new" }));
  assert.equal(merged.due, now + 1000);
  assert.equal(merged.sha, "new");
});

const hour = 60 * 60_000;
const week = 7 * 24 * hour;

test("a new repository gets a security sweep right away, and its other schedules spread out", () => {
  const defaults = hubSettings(new Map());
  const first = scheduledWork(newRecord("Mackery6969/game", 7, "main", now), now, defaults);
  assert.deepEqual(first.jobs.map((entry) => entry.task), ["security"]);
  assert.deepEqual(scheduledWork(first.record, now + 6 * hour - 1, defaults).jobs.filter((entry) => entry.task === "security"), []);
  assert.ok(scheduledWork(first.record, now + 6 * hour, defaults).jobs.some((entry) => entry.task === "security"));
  const inAWeek = scheduledWork(first.record, now + week, defaults).jobs.map((entry) => entry.task);
  for (const task of ["fix", "scan", "quality"]) assert.ok(inAWeek.includes(task as Job["task"]), task);
});

test("each repository's settings set its schedules, and a task that's off is never scheduled", () => {
  const settings = hubSettings(parseConfig("tasks: [security, scan]\nsecurity-every: 1d\nscan-every: 2d\n"));
  const record = { repository: "Mackery6969/game", installation: 7, defaultBranch: "main", last: { security: now - 24 * hour, scan: now - 47 * hour } };
  assert.deepEqual(scheduledWork(record, now, settings).jobs.map((entry) => entry.task), ["security"]);
  assert.deepEqual(scheduledWork(record, now + hour, settings).jobs.map((entry) => entry.task), ["security", "scan"]);
  assert.ok(!scheduledWork(record, now + 30 * week, settings).jobs.some((entry) => entry.task === "fix" || entry.task === "quality"));
});

test("records from before per-task schedules keep their last security sweep and quality pass", () => {
  const legacy = { repository: "Mackery6969/game", installation: 7, defaultBranch: "main", lastSecurity: now - hour, lastQuality: now - hour };
  const work = scheduledWork(legacy, now, hubSettings(new Map()));
  assert.ok(!work.jobs.some((entry) => entry.task === "security" || entry.task === "quality"));
  assert.deepEqual([work.record.last?.security, work.record.last?.quality, "lastSecurity" in work.record], [now - hour, now - hour, false]);
});

test("alerts and issues go to security or fix by severity and labels", () => {
  const securityAlert = enqueued("code_scanning_alert", payload({ action: "created", ref: "refs/heads/main", alert: { rule: { security_severity_level: "high" } } }));
  const plainAlert = enqueued("code_scanning_alert", payload({ action: "created", ref: "refs/heads/main", alert: { rule: { security_severity_level: null } } }));
  assert.deepEqual([securityAlert[0]?.task, plainAlert[0]?.task], ["security", "fix"]);
  assert.equal(enqueued("issues", payload({ action: "labeled", issue: { number: 2, labels: [{ name: "Security" }] } }))[0]?.task, "security");
  assert.equal(enqueued("issues", payload({ action: "opened", issue: { number: 3, labels: [{ name: "bug" }] } }))[0]?.task, "fix");
});

test("pushes become scan candidates with what they touched; Claude's own and its branches don't", () => {
  const push = (ref: string, overrides: Partial<WebhookPayload> = {}) => effectsOf("push", payload({ ref, before: "aaa", after: "bbb", commits: [{ added: ["src/new.ts"], modified: ["src/a.ts", ".github/claude-autofix.yml"] }, { modified: ["src/a.ts"] }], ...overrides }), context).filter((effect) => effect.kind === "push");
  const [effect] = push("refs/heads/feature/login");
  assert.ok(effect?.kind === "push");
  assert.deepEqual([effect.branch, effect.before, effect.after, effect.paths], ["feature/login", "aaa", "bbb", ["src/new.ts", "src/a.ts", ".github/claude-autofix.yml"]]);
  assert.deepEqual(push("refs/heads/claude/scan/x"), []);
  assert.deepEqual(push("refs/heads/main", { deleted: true }), []);
  assert.deepEqual(push("refs/tags/v1"), []);
  assert.deepEqual(push("refs/heads/main", { sender: { login: "claude-autofix[bot]", type: "Bot" } }), []);
});

test("coalesced pushes keep the earliest before, so one scan covers them all", () => {
  assert.equal(mergeJobs(job({ task: "scan", ref: "feature", before: "first", sha: "b" }), job({ task: "scan", ref: "feature", before: "second", sha: "c" })).before, "first");
});

test("due jobs go oldest first, security ahead of quality, a few at a time", () => {
  const jobs = [job({ task: "quality", due: now - 10 }), job({ task: "security", due: now - 10, ref: "a" }), job({ due: now + 10, ref: "later" }), job({ due: now - 20, ref: "oldest" })];
  assert.deepEqual(dueJobs(jobs, now, 2).map((entry) => `${entry.task}:${entry.ref}`), ["security:oldest", "security:a"]);
});

function memoryStore(): KeyValueStore {
  const values = new Map<string, { value: string; metadata?: unknown }>();
  return {
    async get(key) {
      return values.get(key)?.value ?? null;
    },
    async put(key, value, options) {
      values.set(key, { value, metadata: options?.metadata });
    },
    async delete(key) {
      values.delete(key);
    },
    async list({ prefix }) {
      return { keys: [...values].filter(([key]) => key.startsWith(prefix)).map(([name, entry]) => ({ name, metadata: entry.metadata })), list_complete: true };
    },
  };
}

test("only your own repositories and the ones you permit are worked on", async () => {
  const state = new State(memoryStore());
  assert.ok(await state.permitted("Mackery6969/game", ["mackery6969"]));
  assert.ok(!(await state.permitted("someone/project", ["Mackery6969"])));
  await state.permit("Someone/Project");
  assert.ok(await state.permitted("someone/project", ["Mackery6969"]));
  await state.enqueue(job({ repository: "someone/project" }));
  await state.revoke("someone/project");
  assert.ok(!(await state.permitted("someone/project", ["Mackery6969"])));
  assert.deepEqual(await state.jobs(), []);
});

test("queueing the same work twice doesn't write again", async () => {
  let writes = 0;
  const store = memoryStore();
  const counting: KeyValueStore = { ...store, put: async (key, value, options) => (writes++, store.put(key, value, options)) };
  const state = new State(counting);
  await state.enqueue(job());
  const afterFirst = writes;
  await state.enqueue(job());
  assert.equal(writes, afterFirst);
  assert.equal((await state.jobs()).length, 1);
});

function countingLists(store: KeyValueStore): { store: KeyValueStore; lists: () => number } {
  let lists = 0;
  return { store: { ...store, list: async (options) => (lists++, store.list(options)) }, lists: () => lists };
}

test("ticks only list the queue once something could be due, and at least hourly", async () => {
  const { store, lists } = countingLists(memoryStore());
  await new State(store).enqueue(job({ due: now + 10 * 60_000 }));
  assert.deepEqual(await new State(store).jobsIfDue(now), []);
  assert.equal(lists(), 0);
  assert.equal((await new State(store).jobsIfDue(now + 10 * 60_000)).length, 1);
  assert.equal(lists(), 1);
  await new State(store).finish(job());
  assert.deepEqual(await new State(store).jobsIfDue(now + 20 * 60_000), []);
  assert.equal(lists(), 1);
  await new State(store).jobsIfDue(now + 70 * 60_000);
  assert.equal(lists(), 2);
  await new State(store).enqueue(job({ due: now + 71 * 60_000 }));
  assert.equal((await new State(store).jobsIfDue(now + 71 * 60_000)).length, 1);
});

test("repositories come from an index, so ticks don't list them", async () => {
  const { store, lists } = countingLists(memoryStore());
  await new State(store).saveRepository(newRecord("a/one", 1, "main", now));
  assert.deepEqual((await new State(store).repositories()).map((record) => record.repository), ["a/one"]);
  assert.equal(lists(), 1);
  const state = new State(store);
  await state.saveRepository(newRecord("a/two", 1, "main", now));
  await state.forgetRepository("a/one");
  const beforeTicks = lists();
  assert.deepEqual((await new State(store).repositories()).map((record) => record.repository), ["a/two"]);
  await new State(store).repositories();
  assert.equal(lists(), beforeTicks);
});

test("a usage-limit pause only ever moves later", async () => {
  const state = new State(memoryStore());
  await state.pauseUntil(now + 1000);
  await state.pauseUntil(now + 500);
  assert.equal((await state.pause())?.until, now + 1000);
});

test("reports the action signs are accepted by the hub, and tampered ones aren't", async () => {
  const body = JSON.stringify({ kind: "cursor", cursor: "src/a.ts" });
  assert.ok(await verifySignature("secret", body, sign("secret", body)));
  assert.ok(!(await verifySignature("secret", `${body} `, sign("secret", body))));
  assert.ok(!(await verifySignature("other", body, sign("secret", body))));
  assert.ok(!(await verifySignature("secret", body, null)));
  assert.ok(!(await verifySignature("", body, sign("", body))));
});

test("the app's JWT is signed with its RSA key, in the PKCS#1 form GitHub hands out", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  assert.deepEqual(Buffer.from(pkcs8FromPem(pkcs1)), pkcs8);

  const jwt = await appJwt({ clientId: "Iv23test", privateKey: pkcs1 }, now);
  const [header = "", claims = "", signature = ""] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), { iat: now / 1000 - 60, exp: now / 1000 - 60 + 540, iss: "Iv23test" });
  assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, "base64url")));
});

test("the runner gets one workflow per task, each calling the shared one", () => {
  const workflows = runnerWorkflows();
  assert.deepEqual(Object.keys(workflows), [".github/workflows/claude-autofix.yml", ...TASKS.map((task) => `.github/workflows/${task}.yml`)]);
  assert.match(workflows[".github/workflows/claude-autofix.yml"], /workflow_call:/);
  const scan = workflows[".github/workflows/scan.yml"];
  assert.match(scan, /^name: Scan$/m);
  assert.match(scan, /task: scan$/m);
  assert.match(scan, /uses: \.\/\.github\/workflows\/claude-autofix\.yml/);
  assert.doesNotMatch(Object.values(workflows).join("\n"), /__TASK__|__TITLE__/);
});

function actionsToken(claims: Record<string, unknown>, kid = "key-1") {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", kid }))}.${base64Url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  const jwk = publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string };
  return { token: `${unsigned}.${base64Url(new Uint8Array(signature))}`, keys: async (): Promise<SigningKey[]> => [{ ...jwk, kid: "key-1" }] };
}

const seconds = Math.floor(now / 1000);
const goodClaims = { iss: ACTIONS_ISSUER, aud: HUB_AUDIENCE, exp: seconds + 300, nbf: seconds - 10, repository: "me/app", job_workflow_ref: `Mackery6969/Claude-Autofix/${SHARED_WORKFLOW}@refs/tags/v3`, event_name: "workflow_dispatch", actor: "me" };

test("the hub accepts a GitHub Actions token meant for it", async () => {
  const { token, keys } = actionsToken(goodClaims);
  const claims = await verifyActionsToken(token, now, keys);
  assert.equal(claims.repository, "me/app");
});

test("the hub refuses tokens for someone else, expired ones, unknown keys and forged ones", async () => {
  for (const claims of [{ ...goodClaims, aud: "https://github.com/me" }, { ...goodClaims, exp: seconds - 1 }, { ...goodClaims, iss: "https://example.com" }]) {
    const { token, keys } = actionsToken(claims);
    await assert.rejects(verifyActionsToken(token, now, keys), TokenError);
  }
  const unknown = actionsToken(goodClaims, "key-2");
  await assert.rejects(verifyActionsToken(unknown.token, now, unknown.keys), TokenError);
  const forged = actionsToken(goodClaims);
  const [header, , signature] = forged.token.split(".");
  await assert.rejects(verifyActionsToken(`${header}.${base64Url(JSON.stringify({ ...goodClaims, repository: "them/app" }))}.${signature}`, now, forged.keys), TokenError);
});

test("a run signs its reports with a key only good for its own repository", async () => {
  const key = await reportKey("hub-secret", "me/app");
  const body = JSON.stringify({ job: { repository: "me/app" } });
  assert.equal(await verifySignature(key, body, sign(key, body)), true);
  assert.equal(await verifySignature(await reportKey("hub-secret", "me/other"), body, sign(key, body)), false);
  assert.equal(key, await reportKey("hub-secret", "Me/App"));
});

test("the hub installs one workflow per enabled task, each calling the shared one", async () => {
  const files = workflowFiles(["security", "scan"], "Mackery6969/Claude-Autofix", "v3", "https://hub.example.workers.dev");
  assert.deepEqual(Object.keys(files), ["claude-security.yml", "claude-scan.yml"]);
  const scan = files["claude-scan.yml"] ?? "";
  assert.match(scan, /^name: Claude Code Scanning$/m);
  assert.match(scan, /uses: Mackery6969\/Claude-Autofix\/\.github\/workflows\/run\.yml@v3/);
  assert.match(scan, /hub-url: https:\/\/hub\.example\.workers\.dev$/m);
  assert.match(scan, /task: scan$/m);
  assert.match(scan, /id-token: write/);
  assert.match(scan, /number:\n {8}description: Pull request number \(optional/);
  assert.match(scan, /required: false/);
  assert.doesNotMatch(scan, /sha:|before:|cursor:|ref:/);
  assert.match(scan, /run-name: .*\.label \|\| format\('Run by \{0\}/);
  assert.match(workflowFiles(["conversation"], "o/r", "v3", "https://h")["claude-conversation.yml"] ?? "", /description: Pull request or issue number\n {8}required: true/);
  const all = workflowFiles(TASKS, "Mackery6969/Claude-Autofix", "v3", "https://hub.example.workers.dev");
  assert.equal(new Set(Object.keys(all)).size, TASKS.length);
  assert.notEqual(await contentHash(files), await contentHash(all));
  assert.equal(await contentHash(files), await contentHash({ "claude-scan.yml": scan, "claude-security.yml": files["claude-security.yml"] ?? "" }));
});

test("workflow files are compared by their git blob hash", async () => {
  assert.equal(await gitBlobSha("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
});

test("runs the hub starts are named for why they started", () => {
  assert.deepEqual(
    [dispatchLabel({ ref: "main", pullRequest: 3 }), dispatchLabel({ ref: "", issue: 5 }), dispatchLabel({ ref: "dev", before: "abc" }), dispatchLabel({ ref: "main" })],
    ["Pull request #3", "Issue #5", "Push to dev", "Sweep of main"],
  );
});
