import type { HubSettings } from "../../src/base/settings.ts";
import type { Job } from "./routing.ts";

export const SCHEDULED_TASKS = ["security", "fix", "scan", "quality"] as const;
export type ScheduledTask = (typeof SCHEDULED_TASKS)[number];
const TASK_ORDER: Job["task"][] = ["conversation", "security", "fix", "scan", "quality"];

export interface RepositoryRecord {
  repository: string;
  installation: number;
  defaultBranch: string;
  last?: Partial<Record<ScheduledTask, number>>;
  lastSecurity?: number;
  lastQuality?: number;
  workflow?: string;
}

export function spread(repository: string, period: number): number {
  let hash = 2166136261;
  for (const character of repository) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return hash % period;
}

export function newRecord(repository: string, installation: number, defaultBranch: string, now: number): RepositoryRecord {
  return { repository, installation, defaultBranch, last: { security: 0 } };
}

function lastRun(record: RepositoryRecord, task: ScheduledTask, every: number, now: number): number {
  const stored = record.last?.[task] ?? (task === "security" ? record.lastSecurity : task === "quality" ? record.lastQuality : undefined);
  return stored ?? now - every + spread(`${record.repository}|${task}`, every);
}

export function scheduledWork(record: RepositoryRecord, now: number, settings: HubSettings, paused = false): { jobs: Job[]; record: RepositoryRecord } {
  const jobs: Job[] = [];
  const last: Partial<Record<ScheduledTask, number>> = { ...record.last };
  let changed = record.last === undefined;
  for (const task of SCHEDULED_TASKS) {
    const every = settings.every[task];
    if (every === undefined) continue;
    const previous = lastRun(record, task, every, now);
    if (record.last?.[task] === undefined) changed = true;
    last[task] = previous;
    if (now - previous < every) continue;
    if (!paused) jobs.push({ repository: record.repository, installation: record.installation, task, ref: record.defaultBranch, sha: "", pullRequest: undefined, issue: undefined, sender: "", due: now });
    last[task] = now;
    changed = true;
  }
  if (!changed) return { jobs, record };
  const { lastSecurity: _security, lastQuality: _quality, ...rest } = record;
  return { jobs, record: { ...rest, last } };
}

export function dueJobs(jobs: Job[], now: number, limit: number): Job[] {
  return jobs
    .filter((job) => job.due <= now)
    .sort((a, b) => TASK_ORDER.indexOf(a.task) - TASK_ORDER.indexOf(b.task) || a.due - b.due)
    .slice(0, limit);
}
