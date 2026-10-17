import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { sign } from "../src/base/hub.ts";
import { appJwt, pkcs8FromPem } from "../worker/src/github.ts";
import { ALERT_SETTLE_MS, DEPENDABOT_GRACE_MS, effectsOf, jobKey, mergeJobs, type Job, type WebhookPayload } from "../worker/src/routing.ts";
import { dueJobs, newRecord, QUALITY_EVERY_MS, scheduledWork, SECURITY_EVERY_MS } from "../worker/src/schedule.ts";
import { verifySignature } from "../worker/src/signatures.ts";
import { State, type KeyValueStore } from "../worker/src/state.ts";

const now = Date.parse("2026-10-16T12:00:00Z");
const context = { appSlug: "claude-autofix", ignored: ["Mackery6969/claude-autofix-runner", "Mackery6969/Claude-Autofix"], now };
const repository = { full_name: "Mackery6969/game", default_branch: "main" };
const payload = (overrides: WebhookPayload): WebhookPayload => ({ installation: { id: 7 }, repository, sender: { login: "Mackery6969", type: "User" }, ...overrides });
const enqueued = (event: string, body: WebhookPayload) => effectsOf(event, body, context).flatMap((effect) => (effect.kind === "enqueue" ? [effect.job] : []));

const job = (overrides: Partial<Job> = {}): Job => ({ repository: "Mackery6969/game", installation: 7, task: "security", ref: "main", sha: "", pullRequest: undefined, sender: "", due: now, ...overrides });

test("a code scanning alert on the default branch queues a security sweep once the scanner settles", () => {
  const [queued] = enqueued("code_scanning_alert", payload({ action: "created", ref: "refs/heads/main", commit_oid: "abc" }));
  assert.equal(queued?.task, "security");
  assert.equal(queued?.ref, "main");
  assert.equal(queued?.due, now + ALERT_SETTLE_MS);
});

test("alerts on a branch or pull request queue work on just those changes", () => {
  const [branch] = enqueued("code_scanning_alert", payload({ action: "appeared_in_branch", ref: "refs/heads/feature/login", commit_oid: "def" }));
  assert.deepEqual([branch?.ref, branch?.sha, branch?.pullRequest], ["feature/login", "def", undefined]);
  const [pull] = enqueued("code_scanning_alert", payload({ action: "created", ref: "refs/pull/16/merge", commit_oid: "123" }));
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

test("your pull requests get a quality pass; bots, drafts, forks and Claude's own don't", () => {
  const pull = (overrides: Partial<NonNullable<WebhookPayload["pull_request"]>> = {}) => ({ number: 4, user: { login: "Mackery6969", type: "User" }, head: { ref: "feature", sha: "abc", repo: { full_name: "Mackery6969/game" } }, ...overrides });
  const [quality] = enqueued("pull_request", payload({ action: "opened", pull_request: pull() }));
  assert.deepEqual([quality?.task, quality?.pullRequest, quality?.sender], ["quality", 4, "Mackery6969"]);
  assert.deepEqual(enqueued("pull_request", payload({ action: "opened", pull_request: pull({ draft: true }) })), []);
  assert.deepEqual(enqueued("pull_request", payload({ action: "opened", pull_request: pull() })).map((entry) => entry.task), ["quality"]);
  const ready = enqueued("pull_request", payload({ action: "ready_for_review", pull_request: pull() }));
  assert.deepEqual(ready.map((entry) => `${entry.task}:${entry.pullRequest}`), ["quality:4", "security:4"]);
  assert.equal(ready[1]?.due, now + ALERT_SETTLE_MS);
  assert.deepEqual(enqueued("pull_request", payload({ action: "opened", pull_request: pull({ head: { ref: "x", sha: "a", repo: { full_name: "someone/game" } } }) })), []);
  assert.deepEqual(enqueued("pull_request", payload({ action: "synchronize", pull_request: pull() })), []);
  assert.deepEqual(enqueued("pull_request", payload({ action: "opened", pull_request: pull(), sender: { login: "claude-autofix[bot]", type: "Bot" } })), []);
});

test("closing one of Claude's pull requests deletes its branch", () => {
  const effects = effectsOf("pull_request", payload({ action: "closed", pull_request: { number: 9, user: { login: "claude-autofix[bot]", type: "Bot" }, head: { ref: "claude/quality/tidy", sha: "abc", repo: repository } } }), context);
  assert.ok(effects.some((effect) => effect.kind === "delete-branch" && effect.branch === "claude/quality/tidy" && effect.sha === "abc"));
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

test("a new repository gets a sweep right away and its weekly pass spread through the week", () => {
  const record = newRecord("Mackery6969/game", 7, "main", now);
  const first = scheduledWork(record, now);
  assert.deepEqual(first.jobs.map((entry) => entry.task), ["security"]);
  assert.deepEqual(scheduledWork(first.record, now + SECURITY_EVERY_MS - 1).jobs, []);
  assert.deepEqual(scheduledWork(first.record, now + SECURITY_EVERY_MS).jobs.map((entry) => entry.task), ["security"]);
  assert.ok(scheduledWork(first.record, now + QUALITY_EVERY_MS).jobs.some((entry) => entry.task === "quality"));
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
  await state.enqueue(job());
  assert.equal(writes, 1);
  assert.equal((await state.jobs()).length, 1);
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
