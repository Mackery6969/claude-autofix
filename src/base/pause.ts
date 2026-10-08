import { log, notice, setOutput, summary, warn } from "./actions.ts";
import type { GitHub } from "./github.ts";
import { describeLimit, type LimitType, type UsageLimit } from "./limits.ts";

export const PAUSED_TITLE = "claude-paused";
const MARGIN_MS = 2 * 60 * 1000;
const CANCEL_GRACE_MS = 3 * 60 * 1000;

export interface Pause {
  resumeAt: Date;
  limit: LimitType;
}

export function pauseMessage(pause: Pause): string {
  return `resume-at=${pause.resumeAt.toISOString()} limit=${pause.limit}`;
}

export function parsePauseMessage(message: string): Pause | undefined {
  const match = /resume-at=(\S+)\s+limit=(\S+)/.exec(message);
  if (!match) return undefined;
  const resumeAt = new Date(match[1] ?? "");
  return Number.isNaN(resumeAt.getTime()) ? undefined : { resumeAt, limit: (match[2] ?? "unknown") as LimitType };
}

export interface PauseContext {
  github: GitHub;
  runId: string;
  resumeWorkflow: string;
}

export async function pauseRun(usage: UsageLimit, context: PauseContext): Promise<void> {
  const pause: Pause = { resumeAt: new Date(usage.resetsAt.getTime() + MARGIN_MS), limit: usage.type };
  const when = pause.resumeAt.toUTCString();
  notice(pauseMessage(pause), PAUSED_TITLE);
  setOutput("paused", true);
  setOutput("resume-at", pause.resumeAt.toISOString());
  summary(`## Paused: Claude ${describeLimit(pause.limit)} reached\n\nNothing was changed. This run is cancelled and starts again automatically after **${when}**.`);

  try {
    await context.github.enableWorkflow(context.resumeWorkflow);
    log(`Turned on ${context.resumeWorkflow} to start this again after ${when}.`);
  } catch (error) {
    warn(`Couldn't turn on the resume workflow (${context.resumeWorkflow}): ${messageOf(error)}. Add it to this repository (see the README) or this waits for the next scheduled run.`);
  }

  try {
    await context.github.cancelRun(context.runId);
  } catch (error) {
    warn(`Couldn't cancel this run (${messageOf(error)}). Give the workflow "actions: write" so paused runs show as cancelled. It still resumes after ${when}.`);
    return;
  }
  log("Cancelling this run.");
  await new Promise((resolve) => setTimeout(resolve, CANCEL_GRACE_MS));
  warn("The run wasn't cancelled in time; ending it as paused instead.");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
