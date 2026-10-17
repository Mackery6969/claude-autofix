import type { TaskName } from "../../src/base/settings.ts";

export const WORKFLOW_DIRECTORY = ".github/workflows";
export const SHARED_WORKFLOW = ".github/workflows/run.yml";

export const TASK_WORKFLOWS: Record<TaskName, { file: string; name: string }> = {
  security: { file: "claude-security.yml", name: "Claude Security" },
  fix: { file: "claude-fix.yml", name: "Claude Fix" },
  scan: { file: "claude-scan.yml", name: "Claude Code Scanning" },
  quality: { file: "claude-quality.yml", name: "Claude Code Quality" },
  conversation: { file: "claude-conversation.yml", name: "Claude Conversations" },
};

export const WORKFLOW_INPUT = "number";

const NUMBER_INPUT: Record<TaskName, string> = {
  security: "Pull request number (optional; leave empty to work on the branch above)",
  fix: "Pull request number (optional; leave empty to work on the branch above)",
  scan: "Pull request number (optional; leave empty to scan the branch above)",
  quality: "Pull request number (optional; leave empty to work on the branch above)",
  conversation: "Pull request or issue number",
};

export function workflowFile(task: TaskName, actionRepository: string, version: string, hubUrl: string): string {
  const job = "fromJSON(inputs.hub || '{}')";
  return `name: ${TASK_WORKFLOWS[task].name}
run-name: "\${{ ${job}.label || format('Run by {0} · {1}', github.actor, inputs.number && format('#{0}', inputs.number) || github.ref_name) }}"

on:
  workflow_dispatch:
    inputs:
      number:
        description: ${NUMBER_INPUT[task]}
        required: ${task === "conversation"}
        default: ""
      hub:
        description: Leave empty (the hub fills this in)
        default: ""

permissions:
  contents: read
  id-token: write

concurrency:
  group: claude-${task}-\${{ inputs.number || ${job}.pullRequest || ${job}.issue || ${job}.ref || github.ref_name }}
  cancel-in-progress: false

jobs:
  ${task}:
    uses: ${actionRepository}/${SHARED_WORKFLOW}@${version}
    with:
      hub-url: ${hubUrl}
      task: ${task}
      hub: \${{ inputs.hub }}
      number: \${{ inputs.number }}
      branch: \${{ github.ref_name }}
      sender: \${{ !endsWith(github.actor, '[bot]') && github.actor || '' }}
`;
}

export interface DispatchedJob {
  label: string;
  ref: string;
  sha: string;
  before: string;
  pullRequest: string;
  issue: string;
  sender: string;
  cursor: string;
}

export function dispatchLabel(job: { ref: string; pullRequest?: number; issue?: number; before?: string }): string {
  if (job.pullRequest) return `Pull request #${job.pullRequest}`;
  if (job.issue) return `Issue #${job.issue}`;
  if (job.before) return `Push to ${job.ref}`;
  return `Sweep of ${job.ref}`;
}

export function workflowFiles(tasks: readonly TaskName[], actionRepository: string, version: string, hubUrl: string): Record<string, string> {
  return Object.fromEntries(tasks.map((task) => [TASK_WORKFLOWS[task].file, workflowFile(task, actionRepository, version, hubUrl)]));
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function contentHash(files: Record<string, string>): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(Object.entries(files).sort())))).slice(0, 16);
}

export async function gitBlobSha(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const blob = new Uint8Array(header.length + bytes.length);
  blob.set(header);
  blob.set(bytes, header.length);
  return hex(await crypto.subtle.digest("SHA-1", blob));
}
