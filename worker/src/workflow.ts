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

export function workflowFile(task: TaskName, actionRepository: string, version: string, hubUrl: string): string {
  return `name: ${TASK_WORKFLOWS[task].name}
run-name: "\${{ inputs.pull-request && format('Pull request #{0}', inputs.pull-request) || inputs.issue && format('Issue #{0}', inputs.issue) || inputs.ref || github.ref_name }}"

on:
  workflow_dispatch:
    inputs:
      ref:
        description: Branch (leave empty for the default branch; any other branch gets only what differs from it)
        default: ""
      pull-request:
        description: Pull request number
        default: ""
      issue:
        description: Issue number
        default: ""
      sha:
        description: Commit of the branch (set by the hub)
        default: ""
      before:
        description: The commit before a push, to scan only what it changed (set by the hub)
        default: ""
      sender:
        description: Who made the change (set by the hub)
        default: ""
      cursor:
        description: Where the last pass stopped (set by the hub)
        default: ""

permissions:
  contents: read
  id-token: write

concurrency:
  group: claude-${task}-\${{ inputs.pull-request || inputs.issue || inputs.ref }}
  cancel-in-progress: false

jobs:
  ${task}:
    uses: ${actionRepository}/${SHARED_WORKFLOW}@${version}
    with:
      hub-url: ${hubUrl}
      task: ${task}
      ref: \${{ inputs.ref }}
      sha: \${{ inputs.sha }}
      before: \${{ inputs.before }}
      pull-request: \${{ inputs.pull-request }}
      issue: \${{ inputs.issue }}
      sender: \${{ inputs.sender || (!endsWith(github.actor, '[bot]') && github.actor || '') }}
      cursor: \${{ inputs.cursor }}
`;
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
