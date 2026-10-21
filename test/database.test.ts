import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DatabaseStore, type Database, type Statement } from "../worker/src/database.ts";
import { State, type KeyValueStore } from "../worker/src/state.ts";

function sqlite(): Database {
  const db = new DatabaseSync(":memory:");
  const statement = (query: string, values: unknown[] = []): Statement => ({
    bind: (...bound) => statement(query, bound),
    first: async <T>() => (db.prepare(query).get(...(values as never[])) as T | undefined) ?? null,
    all: async <T>() => ({ results: db.prepare(query).all(...(values as never[])) as T[] }),
    run: async () => db.prepare(query).run(...(values as never[])),
  });
  return { prepare: (query) => statement(query), batch: async (statements) => Promise.all(statements.map((each) => each.run())) };
}

function kv(entries: Record<string, { value: string; metadata?: unknown }>): KeyValueStore {
  const values = new Map(Object.entries(entries));
  return {
    get: async (key) => values.get(key)?.value ?? null,
    put: async (key, value, options) => void values.set(key, { value, metadata: options?.metadata }),
    delete: async (key) => void values.delete(key),
    list: async ({ prefix }) => ({ keys: [...values].filter(([key]) => key.startsWith(prefix)).map(([name, entry]) => ({ name, metadata: entry.metadata })), list_complete: true }),
  };
}

test("the database keeps values and metadata, and lists only the prefix asked for", async () => {
  const store = new DatabaseStore(sqlite());
  await store.put("job:a", "1", { metadata: { due: 1 } });
  await store.put("job:b", "2");
  await store.put("jobs", "3");
  await store.put("job:a", "4", { metadata: { due: 2 } });
  assert.equal(await store.get("job:a"), "4");
  assert.deepEqual((await store.list({ prefix: "job:" })).keys, [{ name: "job:a", metadata: { due: 2 } }, { name: "job:b" }]);
  await store.delete("job:a");
  assert.equal(await store.get("job:a"), null);
});

test("the hub's state is copied from KV once, without overwriting anything newer", async () => {
  const db = sqlite();
  const legacy = kv({ "permit:someone/project": { value: "1", metadata: "someone/project" }, "cursor:a/one|scan": { value: "src/b.ts" } });
  await db.prepare("CREATE TABLE entries (key TEXT PRIMARY KEY, value TEXT NOT NULL, metadata TEXT) WITHOUT ROWID").run();
  await db.prepare("INSERT INTO entries VALUES ('cursor:a/one|scan', 'src/z.ts', NULL)").run();
  const state = new State(new DatabaseStore(db, legacy));
  assert.ok(await state.permitted("someone/project", []));
  assert.deepEqual(await state.permits(), ["someone/project"]);
  assert.equal(await state.cursor("a/one", "scan"), "src/z.ts");
  await legacy.put("permit:other/project", "1", { metadata: "other/project" });
  assert.deepEqual(await new State(new DatabaseStore(db, legacy)).permits(), ["someone/project"]);
});
