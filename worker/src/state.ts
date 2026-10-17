import { jobKey, mergeJobs, type Job } from "./routing.ts";
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

export class State {
  readonly #store: KeyValueStore;

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
  }

  async postpone(job: Job, due: number): Promise<void> {
    const postponed = { ...job, due };
    await this.#store.put(jobKey(job), JSON.stringify(postponed), { metadata: postponed });
  }

  jobs(): Promise<Job[]> {
    return this.#listed<Job>("job:");
  }

  async finish(job: Job): Promise<void> {
    await this.#store.delete(jobKey(job));
  }

  repository(name: string): Promise<RepositoryRecord | undefined> {
    return this.#read<RepositoryRecord>(`repo:${name}`);
  }

  repositories(): Promise<RepositoryRecord[]> {
    return this.#listed<RepositoryRecord>("repo:");
  }

  async saveRepository(record: RepositoryRecord): Promise<void> {
    await this.#store.put(`repo:${record.repository}`, JSON.stringify(record), { metadata: record });
  }

  async forgetRepository(name: string): Promise<void> {
    await this.#store.delete(`repo:${name}`);
    await this.#store.delete(`cursor:${name}`);
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

  async cursor(repository: string): Promise<string> {
    return (await this.#store.get(`cursor:${repository}`)) ?? "";
  }

  async saveCursor(repository: string, cursor: string): Promise<void> {
    await this.#store.put(`cursor:${repository}`, cursor);
  }
}
