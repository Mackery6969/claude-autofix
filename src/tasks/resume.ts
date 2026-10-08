import { log, setOutput, summary, warn } from "../base/actions.ts";
import { GitHubError, type GitHub, type WorkflowRun } from "../base/github.ts";
import { parsePauseMessage, PAUSED_TITLE, type Pause } from "../base/pause.ts";

export interface ResumeSettings {
  github: GitHub;
  runId: string;
  now: Date;
}

const LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;
const RUNS_CHECKED_PER_WORKFLOW = 10;
const INCONCLUSIVE = new Set(["cancelled", "skipped"]);

export interface RunGroup {
  pullRequest: boolean;
  runs: WorkflowRun[];
}

export function runsByWorkflow(runs: WorkflowRun[], branch: string, skipWorkflow: number): RunGroup[] {
  const grouped = new Map<string, RunGroup>();
  for (const run of runs) {
    const pullRequest = run.event.startsWith("pull_request");
    if (run.workflow_id === skipWorkflow || (!pullRequest && run.head_branch !== branch)) continue;
    const key = `${run.workflow_id}:${pullRequest ? `pr:${run.head_branch}` : "default"}`;
    const group = grouped.get(key) ?? { pullRequest, runs: [] };
    group.runs.push(run);
    grouped.set(key, group);
  }
  return [...grouped.values()].map((group) => ({ ...group, runs: group.runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)) }));
}

export async function findPause(newestFirst: WorkflowRun[], pauseOf: (run: WorkflowRun) => Promise<Pause | undefined>): Promise<{ run: WorkflowRun; pause: Pause } | undefined> {
  for (const run of newestFirst.slice(0, RUNS_CHECKED_PER_WORKFLOW)) {
    if (run.status !== "completed") return undefined;
    const pause = await pauseOf(run);
    if (pause) return { run, pause };
    if (!INCONCLUSIVE.has(run.conclusion ?? "")) return undefined;
  }
  return undefined;
}

export async function resume(settings: ResumeSettings): Promise<void> {
  const { github, now } = settings;
  const own = await github.workflowRun(settings.runId);
  const branch = await github.defaultBranch();
  const workflows = runsByWorkflow(await github.recentRuns(new Date(now.getTime() - LOOKBACK_MS)), branch, own.workflow_id);

  const restarted: string[] = [];
  const waiting: string[] = [];
  for (const group of workflows) {
    try {
      const paused = await findPause(group.runs, (run) => pauseOf(github, run));
      if (!paused) continue;
      const label = group.pullRequest ? `${paused.run.name} on ${paused.run.head_branch}` : paused.run.name;
      if (paused.pause.resumeAt.getTime() > now.getTime()) {
        waiting.push(`${label} (after ${paused.pause.resumeAt.toUTCString()})`);
        continue;
      }
      if (group.pullRequest) {
        await github.rerun(paused.run.id);
        log(`Re-ran ${label} (${paused.run.html_url}).`);
      } else {
        await restart(github, paused.run, branch);
      }
      restarted.push(label);
    } catch (error) {
      warn(`Couldn't check or restart ${group.runs[0]?.name ?? "a workflow"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  setOutput("resumed", restarted.length);
  report(restarted, waiting);
  if (waiting.length > 0) return;
  try {
    await github.disableWorkflow(own.workflow_id);
    log("Nothing else is paused, so this workflow is turning itself off until a run pauses again.");
  } catch (error) {
    warn(`Couldn't turn this workflow off (${error instanceof Error ? error.message : String(error)}). It keeps polling; give it "actions: write" to let it switch off.`);
  }
}

async function pauseOf(github: GitHub, run: WorkflowRun): Promise<Pause | undefined> {
  const marker = await github.runAnnotation(run.id, PAUSED_TITLE);
  return marker ? parsePauseMessage(marker.message) : undefined;
}

async function restart(github: GitHub, run: WorkflowRun, branch: string): Promise<void> {
  try {
    await github.dispatchWorkflow(run.workflow_id, branch);
    log(`Started ${run.name} again on ${branch}.`);
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 422) throw error;
    await github.rerun(run.id);
    log(`Re-ran ${run.name} (${run.html_url}); it has no workflow_dispatch trigger to start a fresh run.`);
  }
}

function report(restarted: string[], waiting: string[]): void {
  const lines = ["## Claude resume check", ""];
  if (restarted.length) lines.push(`Started again: ${restarted.join(", ")}`);
  if (waiting.length) lines.push(`Still waiting for the usage limit to reset: ${waiting.join(", ")}`);
  if (!restarted.length && !waiting.length) lines.push("Nothing is paused.");
  summary(lines.join("\n"));
  for (const line of lines.slice(2)) log(line);
}
