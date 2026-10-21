import type { KeyValueStore } from "./state.ts";

export interface Database {
  prepare(query: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}

export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

const SCHEMA = "CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, value TEXT NOT NULL, metadata TEXT) WITHOUT ROWID";
const IMPORTED_KEY = "meta:imported-kv";
const UPSERT = "INSERT INTO entries (key, value, metadata) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, metadata = excluded.metadata";
const INSERT_MISSING = "INSERT OR IGNORE INTO entries (key, value, metadata) VALUES (?1, ?2, ?3)";
const IMPORT_BATCH = 50;
const prepared = new WeakMap<Database, Promise<void>>();

export class DatabaseStore implements KeyValueStore {
  readonly #db: Database;
  readonly #legacy: KeyValueStore | undefined;

  constructor(db: Database, legacy?: KeyValueStore) {
    this.#db = db;
    this.#legacy = legacy;
  }

  #ready(): Promise<void> {
    let ready = prepared.get(this.#db);
    if (!ready) {
      ready = this.#prepare().catch((error: unknown) => {
        prepared.delete(this.#db);
        throw error;
      });
      prepared.set(this.#db, ready);
    }
    return ready;
  }

  async #prepare(): Promise<void> {
    await this.#db.prepare(SCHEMA).run();
    if (!this.#legacy || (await this.#db.prepare("SELECT 1 FROM entries WHERE key = ?1").bind(IMPORTED_KEY).first())) return;
    try {
      await this.#importFrom(this.#legacy);
    } catch (error) {
      console.log(`Couldn't copy the hub's state from KV yet: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #importFrom(legacy: KeyValueStore): Promise<void> {
    const statements: Statement[] = [];
    let cursor: string | undefined;
    do {
      const page = await legacy.list({ prefix: "", cursor });
      for (const { name, metadata } of page.keys) {
        const value = await legacy.get(name);
        if (value !== null) statements.push(this.#db.prepare(INSERT_MISSING).bind(name, value, metadata === undefined ? null : JSON.stringify(metadata)));
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    for (let start = 0; start < statements.length; start += IMPORT_BATCH) await this.#db.batch(statements.slice(start, start + IMPORT_BATCH));
    await this.#db.prepare(UPSERT).bind(IMPORTED_KEY, String(statements.length), null).run();
    console.log(`Copied ${statements.length} entries from KV.`);
  }

  async get(key: string): Promise<string | null> {
    await this.#ready();
    return (await this.#db.prepare("SELECT value FROM entries WHERE key = ?1").bind(key).first<{ value: string }>())?.value ?? null;
  }

  async put(key: string, value: string, options?: { metadata?: unknown }): Promise<void> {
    await this.#ready();
    await this.#db.prepare(UPSERT).bind(key, value, options?.metadata === undefined ? null : JSON.stringify(options.metadata)).run();
  }

  async delete(key: string): Promise<void> {
    await this.#ready();
    await this.#db.prepare("DELETE FROM entries WHERE key = ?1").bind(key).run();
  }

  async list({ prefix }: { prefix: string; cursor?: string }): Promise<{ keys: Array<{ name: string; metadata?: unknown }>; list_complete: boolean }> {
    await this.#ready();
    const { results } = await this.#db.prepare("SELECT key, metadata FROM entries WHERE key >= ?1 AND key < ?2 ORDER BY key").bind(prefix, `${prefix}￿`).all<{ key: string; metadata: string | null }>();
    return { keys: results.map(({ key, metadata }) => ({ name: key, ...(metadata === null ? {} : { metadata: JSON.parse(metadata) as unknown }) })), list_complete: true };
  }
}
