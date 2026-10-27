import { jobKey, mergeJobs, type Job } from "./routing.ts";
import { hubSettings, type HubSettings } from "../../src/base/settings.ts";
import type { RepositoryRecord } from "./schedule.ts";

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{ keys: Array<{ name: string; metadata?: unknown }>; list_complete: boolean; cursor?: string }>;
}

export interface Pause {
  until: number;
}

const PAUSE_KEY = "pause";
const REPOSITORY_INDEX_KEY = "index:repositories";
const NEXT_DUE_KEY = "next-due";
const JOB_RECHECK_MS = 60 * 60_000;

export class State {
  readonly #store: KeyValueStore;
  #records: Map<string, RepositoryRecord> | undefined;

  constructor(store: KeyValueStore) {
    this.#store = store;
  }

  async #read<T>(key: string): Promise<T | undefined> {
    const value = await this.#store.get(key);
    return value === null ? undefined : (JSON.parse(value) as T);
  }

  async #listed<T>(prefix: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#store.list({ prefix, cursor });
      for (const key of page.keys) if (key.metadata) items.push(key.metadata as T);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return items;
  }

  async enqueue(job: Job): Promise<void> {
    const key = jobKey(job);
    const existing = await this.#read<Job>(key);
    const merged = mergeJobs(existing, job);
    if (existing && JSON.stringify(existing) === JSON.stringify(merged)) return;
    await this.#store.put(key, JSON.stringify(merged), { metadata: merged });
    await this.expectJobAt(merged.due);
  }

  async postpone(job: Job, due: number): Promise<void> {
    const postponed = { ...job, due };
    await this.#store.put(jobKey(job), JSON.stringify(postponed), { metadata: postponed });
    await this.expectJobAt(due);
  }

  async expectJobAt(due: number): Promise<void> {
    const next = await this.#store.get(NEXT_DUE_KEY);
    if (next === null || due < Number(next)) await this.#store.put(NEXT_DUE_KEY, String(due));
  }

  async jobsIfDue(now: number): Promise<Job[]> {
    if (Number((await this.#store.get(NEXT_DUE_KEY)) ?? 0) > now) return [];
    await this.#store.put(NEXT_DUE_KEY, String(now + JOB_RECHECK_MS));
    return this.jobs();
  }

  jobs(): Promise<Job[]> {
    return this.#listed<Job>("job:");
  }

  async isQueued(job: Job): Promise<boolean> {
    return (await this.#store.get(jobKey(job))) !== null;
  }

  async finish(job: Job): Promise<void> {
    await this.#store.delete(jobKey(job));
  }

  repository(name: string): Promise<RepositoryRecord | undefined> {
    return this.#read<RepositoryRecord>(`repo:${name}`);
  }

  async repositories(): Promise<RepositoryRecord[]> {
    if (!this.#records) {
      const names = await this.#read<string[]>(REPOSITORY_INDEX_KEY);
      const records = names ? (await Promise.all(names.map((name) => this.repository(name)))).filter((record) => record !== undefined) : await this.listedRepositories();
      if (!names) await this.indexRepositories(records.map((record) => record.repository));
      this.#records = new Map(records.map((record) => [record.repository, record]));
    }
    return [...this.#records.values()];
  }

  listedRepositories(): Promise<RepositoryRecord[]> {
    return this.#listed<RepositoryRecord>("repo:");
  }

  async indexRepositories(names: string[]): Promise<void> {
    await this.#store.put(REPOSITORY_INDEX_KEY, JSON.stringify(names));
    this.#records = undefined;
  }

  async #updateIndex(change: (names: string[]) => string[]): Promise<void> {
    const names = await this.#read<string[]>(REPOSITORY_INDEX_KEY);
    if (!names) return;
    const changed = change(names);
    if (changed.length !== names.length) await this.#store.put(REPOSITORY_INDEX_KEY, JSON.stringify(changed));
  }

  async saveRepository(record: RepositoryRecord): Promise<void> {
    await this.#store.put(`repo:${record.repository}`, JSON.stringify(record), { metadata: record });
    if (!this.#records?.has(record.repository)) await this.#updateIndex((names) => (names.includes(record.repository) ? names : [...names, record.repository]));
    this.#records?.set(record.repository, record);
  }

  async forgetRepository(name: string): Promise<void> {
    await this.#store.delete(`repo:${name}`);
    await this.#updateIndex((names) => names.filter((indexed) => indexed !== name));
    this.#records?.delete(name);
    await this.#store.delete(`cursor:${name}`);
    await this.#store.delete(`settings:${name}`);
    for (const task of ["scan", "quality"]) await this.#store.delete(`cursor:${name}|${task}`);
    for (const job of await this.jobs()) if (job.repository === name) await this.finish(job);
  }

  pause(): Promise<Pause | undefined> {
    return this.#read<Pause>(PAUSE_KEY);
  }

  async pauseUntil(until: number): Promise<void> {
    const current = await this.pause();
    if (current && current.until >= until) return;
    await this.#store.put(PAUSE_KEY, JSON.stringify({ until }));
  }

  async permitted(repository: string, owners: string[]): Promise<boolean> {
    const owner = repository.split("/")[0]?.toLowerCase() ?? "";
    if (owners.some((permittedOwner) => permittedOwner.toLowerCase() === owner)) return true;
    return (await this.#store.get(`permit:${repository.toLowerCase()}`)) !== null;
  }

  async permit(repository: string): Promise<void> {
    await this.#store.put(`permit:${repository.toLowerCase()}`, "1", { metadata: repository.toLowerCase() });
  }

  async revoke(repository: string): Promise<void> {
    await this.#store.delete(`permit:${repository.toLowerCase()}`);
    for (const job of await this.jobs()) if (job.repository.toLowerCase() === repository.toLowerCase()) await this.finish(job);
  }

  permits(): Promise<string[]> {
    return this.#listed<string>("permit:");
  }

  async lastSync(): Promise<number> {
    return Number((await this.#store.get("synced")) ?? 0);
  }

  async synced(now: number): Promise<void> {
    await this.#store.put("synced", String(now));
  }

  async cursor(repository: string, task: string): Promise<string> {
    const saved = await this.#store.get(`cursor:${repository}|${task}`);
    if (saved !== null) return saved;
    return task === "quality" ? ((await this.#store.get(`cursor:${repository}`)) ?? "") : "";
  }

  async saveCursor(repository: string, task: string, cursor: string): Promise<void> {
    await this.#store.put(`cursor:${repository}|${task}`, cursor);
  }

  async settings(repository: string): Promise<HubSettings> {
    return (await this.#read<HubSettings>(`settings:${repository}`)) ?? hubSettings(new Map());
  }

  async saveSettings(repository: string, settings: HubSettings): Promise<void> {
    const key = `settings:${repository}`;
    const value = JSON.stringify(settings);
    if ((await this.#store.get(key)) !== value) await this.#store.put(key, value);
  }
}
