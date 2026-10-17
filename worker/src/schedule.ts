import type { Job } from "./routing.ts";

export const SECURITY_EVERY_MS = 6 * 60 * 60_000;
export const QUALITY_EVERY_MS = 7 * 24 * 60 * 60_000;

export interface RepositoryRecord {
  repository: string;
  installation: number;
  defaultBranch: string;
  lastSecurity: number;
  lastQuality: number;
}

export function spread(repository: string, period: number): number {
  let hash = 2166136261;
  for (const character of repository) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return hash % period;
}

export function newRecord(repository: string, installation: number, defaultBranch: string, now: number): RepositoryRecord {
  return {
    repository,
    installation,
    defaultBranch,
    lastSecurity: now - SECURITY_EVERY_MS,
    lastQuality: now - QUALITY_EVERY_MS + spread(repository, QUALITY_EVERY_MS),
  };
}

export function scheduledWork(record: RepositoryRecord, now: number): { jobs: Job[]; record: RepositoryRecord } {
  const jobs: Job[] = [];
  const next = { ...record };
  const job = (task: Job["task"]): Job => ({ repository: record.repository, installation: record.installation, task, ref: record.defaultBranch, sha: "", pullRequest: undefined, sender: "", due: now });
  if (now - record.lastSecurity >= SECURITY_EVERY_MS) {
    jobs.push(job("security"));
    next.lastSecurity = now;
  }
  if (now - record.lastQuality >= QUALITY_EVERY_MS) {
    jobs.push(job("quality"));
    next.lastQuality = now;
  }
  return { jobs, record: next };
}

export function dueJobs(jobs: Job[], now: number, limit: number): Job[] {
  return jobs
    .filter((job) => job.due <= now)
    .sort((a, b) => a.due - b.due || (a.task === b.task ? 0 : a.task === "security" ? -1 : 1))
    .slice(0, limit);
}
