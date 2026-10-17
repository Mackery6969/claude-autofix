import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASKS } from "../src/base/settings.ts";

export const ACTION_REPOSITORY = "Mackery6969/Claude-Autofix";
const RUNNER_WORKFLOWS = ".github/workflows";
const WRANGLER = ["--yes", "wrangler@4"];
const WRANGLER_CONFIG = new URL("../worker/wrangler.jsonc", import.meta.url).pathname;
const RUNNER_TEMPLATE = new URL("../examples/runner.yml", import.meta.url);
const RUNNER_TASK_TEMPLATE = new URL("../examples/runner-task.yml", import.meta.url);

export class SetupError extends Error {}

export interface HubSettings {
  clientId: string;
  slug: string;
  runner: string;
  owners: string[];
  ignored: string[];
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

const TOKEN_HELP = `The Cloudflare API token can't manage Workers on this account. Edit it under My Profile → API Tokens (or make one from the "Edit Cloudflare Workers" template) with:
  Account → Workers Scripts → Edit, Workers KV Storage → Edit, Account Settings → Read
  User → Memberships → Read, User Details → Read
  Account Resources → Include → the account in CLOUDFLARE_ACCOUNT_ID
then update the CLOUDFLARE_API_TOKEN secret and run Deploy hub again.`;

function wrangler(args: string[], failure: string): string {
  const result = run("npx", [...WRANGLER, ...args, "--config", WRANGLER_CONFIG]);
  if (result.ok) return result.stdout;
  const output = `${result.stderr}\n${result.stdout}`.trim();
  if (/No access to the specified resource|Authentication error|\[code: 10000\]/i.test(output)) throw new SetupError(`${failure}\n${TOKEN_HELP}\n\n${output}`);
  if (/workers\.dev subdomain/i.test(output)) throw new SetupError(`${failure}\nThis Cloudflare account has no workers.dev subdomain yet. Open Workers & Pages in the Cloudflare dashboard once to pick one, then run Deploy hub again.\n\n${output}`);
  throw new SetupError(`${failure}\n${output}`);
}

export function deployWorker(settings: HubSettings): string {
  const vars = { APP_CLIENT_ID: settings.clientId, APP_SLUG: settings.slug, RUNNER_REPOSITORY: settings.runner, PERMITTED_OWNERS: settings.owners.join(","), IGNORED_REPOSITORIES: settings.ignored.join(",") };
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

export function releasedActionVersion(workflow: string): string | undefined {
  const version = new RegExp(`uses: ${ACTION_REPOSITORY}@(\\S+)`, "i").exec(workflow)?.[1];
  if (!version) return undefined;
  return run("gh", ["api", `repos/${ACTION_REPOSITORY}/git/ref/tags/${version}`, "--silent"]).ok ? version : undefined;
}

export function runnerWorkflows(): Record<string, string> {
  const template = readFileSync(RUNNER_TASK_TEMPLATE, "utf8");
  const workflows: Record<string, string> = { [`${RUNNER_WORKFLOWS}/claude-autofix.yml`]: readFileSync(RUNNER_TEMPLATE, "utf8") };
  for (const task of TASKS) workflows[`${RUNNER_WORKFLOWS}/${task}.yml`] = template.replaceAll("__TITLE__", task[0].toUpperCase() + task.slice(1)).replaceAll("__TASK__", task);
  return workflows;
}

export function writeRunnerWorkflows(runner: string): string[] {
  const workflows = runnerWorkflows();
  if (!releasedActionVersion(Object.values(workflows)[0])) throw new SetupError(`The runner workflow uses a version of ${ACTION_REPOSITORY} that isn't released yet, so ${runner} keeps its current workflows. The release deploys them.`);
  const updated: string[] = [];
  for (const [path, content] of Object.entries(workflows)) {
    const existing = run("gh", ["api", `repos/${runner}/contents/${path}`, "--jq", ".sha + \" \" + .content"]);
    const [sha, ...encoded] = existing.ok ? existing.stdout.split(" ") : [];
    if (sha && Buffer.from(encoded.join("").replace(/\\n|\s/g, ""), "base64").toString("utf8") === content) continue;
    const fields = ["-f", `message=Update the Claude Autofix runner workflow ${path}`, "-f", `content=${Buffer.from(content).toString("base64")}`, ...(sha ? ["-f", `sha=${sha}`] : [])];
    const result = run("gh", ["api", "-X", "PUT", `repos/${runner}/contents/${path}`, ...fields, "--silent"]);
    if (!result.ok) throw new SetupError(`Couldn't write ${path} to ${runner}. The app needs the Workflows permission.\n${result.stderr}`);
    updated.push(path);
  }
  return updated;
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
