import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ACTION_REPOSITORY = "Mackery6969/Claude-Autofix";
export const RUNNER_WORKFLOW = ".github/workflows/claude-autofix.yml";
const WRANGLER = ["--yes", "wrangler@4"];
const WRANGLER_CONFIG = new URL("../worker/wrangler.jsonc", import.meta.url).pathname;
const RUNNER_TEMPLATE = new URL("../examples/runner.yml", import.meta.url);

export class SetupError extends Error {}

export interface HubSettings {
  clientId: string;
  slug: string;
  runner: string;
  owners: string[];
}

export function run(command: string, args: string[], input?: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", input });
  if (result.error) throw new SetupError(`${command} isn't installed or isn't on PATH.`);
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

export function must(command: string, args: string[], failure: string, input?: string): string {
  const result = run(command, args, input);
  if (!result.ok) throw new SetupError(`${failure}\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function wrangler(args: string[], failure: string): string {
  return must("npx", [...WRANGLER, ...args, "--config", WRANGLER_CONFIG], failure);
}

export function deployWorker(settings: HubSettings): string {
  const vars = { APP_CLIENT_ID: settings.clientId, APP_SLUG: settings.slug, RUNNER_REPOSITORY: settings.runner, PERMITTED_OWNERS: settings.owners.join(",") };
  const output = wrangler(["deploy", ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`])], "Couldn't deploy the hub to Cloudflare.");
  const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(output)?.[0];
  if (!url) throw new SetupError(`Deployed, but couldn't find the hub's URL in Wrangler's output:\n${output}`);
  return url;
}

export function putWorkerSecrets(secrets: Record<string, string>): void {
  const file = join(process.env.RUNNER_TEMP ?? tmpdir(), `hub-secrets-${process.pid}.json`);
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  try {
    wrangler(["secret", "bulk", file], "Couldn't set the hub's secrets.");
  } finally {
    rmSync(file, { force: true });
  }
}

export function writeRunnerWorkflow(runner: string): boolean {
  const content = readFileSync(RUNNER_TEMPLATE, "utf8");
  const existing = run("gh", ["api", `repos/${runner}/contents/${RUNNER_WORKFLOW}`, "--jq", ".sha + \" \" + .content"]);
  const [sha, ...encoded] = existing.ok ? existing.stdout.split(" ") : [];
  if (sha && Buffer.from(encoded.join("").replace(/\\n|\s/g, ""), "base64").toString("utf8") === content) return false;
  const fields = ["-f", "message=Update the Claude Autofix runner workflow", "-f", `content=${Buffer.from(content).toString("base64")}`, ...(sha ? ["-f", `sha=${sha}`] : [])];
  const result = run("gh", ["api", "-X", "PUT", `repos/${runner}/contents/${RUNNER_WORKFLOW}`, ...fields, "--silent"]);
  if (!result.ok) throw new SetupError(`Couldn't write ${RUNNER_WORKFLOW} to ${runner}. The app needs the Workflows permission.\n${result.stderr}`);
  return true;
}

export function setOnRepository(repository: string, secrets: Record<string, string>, variables: Record<string, string>): void {
  for (const [name, value] of Object.entries(secrets)) {
    must("gh", ["secret", "set", name, "--repo", repository], `Couldn't set the secret ${name} on ${repository}. A GitHub App needs the Secrets permission.`, value);
    console.log(`Set secret ${name} on ${repository}`);
  }
  for (const [name, value] of Object.entries(variables)) {
    must("gh", ["variable", "set", name, "--repo", repository, "--body", value], `Couldn't set the variable ${name} on ${repository}. A GitHub App needs the Variables permission.`);
    console.log(`Set variable ${name} on ${repository}`);
  }
}
