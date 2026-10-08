import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withoutRunnerSecrets } from "./claude.ts";

export interface HelperScript {
  name: string;
  body: string;
}

export function writeHelperScript(directory: string, workspace: string, script: HelperScript): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, script.name).replace(/\\/g, "/");
  const lines = ["set -euo pipefail", "unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN", `cd ${shellQuote(workspace)}`, script.body.trim() || 'echo "Nothing to run."'];
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o755 });
  return path;
}

export interface ScriptResult {
  ok: boolean;
  stdout: string;
  output: string;
}

export function runHelperScript(path: string): ScriptResult {
  const result = spawnSync("bash", [path], { encoding: "utf8", env: withoutRunnerSecrets(), maxBuffer: 64 * 1024 * 1024 });
  const stdout = result.stdout ?? "";
  return { ok: result.status === 0, stdout, output: `${stdout}${result.stderr ?? ""}` };
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
