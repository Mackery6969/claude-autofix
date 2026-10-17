import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { FILES, readSaved, save, savedOrNewSecret } from "./home.ts";

const RUNNER_WORKFLOW = ".github/workflows/claude-autofix.yml";
const WRANGLER = ["--yes", "wrangler@4"];
const WRANGLER_CONFIG = new URL("../worker/wrangler.jsonc", import.meta.url).pathname;
const RUNNER_TEMPLATE = new URL("../examples/runner.yml", import.meta.url);
const WEBHOOK_EVENTS = ["Code scanning alert", "Dependabot alert", "Issues", "Pull request"];

interface Options {
  runner: string | undefined;
  clientId: string;
  slug: string;
  owners: string[];
}

class SetupError extends Error {}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function parseArguments(args: string[]): Options {
  const clientId = option(args, "--client-id");
  const slug = option(args, "--app-slug");
  if (!clientId || !slug) throw new SetupError("Usage: node scripts/setup-hub.ts --client-id <app client ID> --app-slug <app slug> [--runner owner/claude-autofix-runner] [--owners you,your-org]");
  return { runner: option(args, "--runner"), clientId, slug, owners: (option(args, "--owners") ?? "").split(",").map((owner) => owner.trim()).filter(Boolean) };
}

function run(command: string, args: string[], input?: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", input });
  if (result.error) throw new SetupError(`${command} isn't installed or isn't on PATH.`);
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function must(command: string, args: string[], failure: string, input?: string): string {
  const result = run(command, args, input);
  if (!result.ok) throw new SetupError(`${failure}\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function required(path: string, what: string): string {
  const value = readSaved(path);
  if (!value) throw new SetupError(`${path} is missing or empty. Save ${what} there (see the README).`);
  return value;
}

function ensureRunner(runner: string): void {
  if (!run("gh", ["repo", "view", runner, "--json", "name"]).ok) {
    must("gh", ["repo", "create", runner, "--private", "--add-readme", "--description", "Runs Claude Autofix for the repositories the hub permits."], `Couldn't create ${runner}.`);
    console.log(`Created the private runner repository ${runner}`);
  }
  const existing = run("gh", ["api", `repos/${runner}/contents/${RUNNER_WORKFLOW}`, "--jq", ".sha"]);
  const content = Buffer.from(readFileSync(RUNNER_TEMPLATE, "utf8")).toString("base64");
  const fields = ["-f", `message=Update the Claude Autofix runner workflow`, "-f", `content=${content}`, ...(existing.ok ? ["-f", `sha=${existing.stdout}`] : [])];
  const result = run("gh", ["api", "-X", "PUT", `repos/${runner}/contents/${RUNNER_WORKFLOW}`, ...fields, "--silent"]);
  if (!result.ok) {
    const hint = /workflow/i.test(result.stderr) ? "\nYour gh login can't change workflow files yet. Run: gh auth refresh -s workflow" : "";
    throw new SetupError(`Couldn't write ${RUNNER_WORKFLOW} to ${runner}.\n${result.stderr}${hint}`);
  }
  console.log(`Wrote ${RUNNER_WORKFLOW} to ${runner}`);
}

function setRunnerSecrets(runner: string, secrets: Record<string, string>, variables: Record<string, string>): void {
  for (const [name, value] of Object.entries(secrets)) {
    must("gh", ["secret", "set", name, "--repo", runner], `Couldn't set ${name} on ${runner}.`, value);
    console.log(`Set secret ${name} on ${runner}`);
  }
  for (const [name, value] of Object.entries(variables)) {
    must("gh", ["variable", "set", name, "--repo", runner, "--body", value], `Couldn't set ${name} on ${runner}.`);
    console.log(`Set variable ${name} on ${runner}`);
  }
}

function deployHub(vars: Record<string, string>, secrets: Record<string, string>): string {
  const whoami = run("npx", [...WRANGLER, "whoami"]);
  if (!whoami.ok || /not authenticated|not logged in/i.test(`${whoami.stdout}\n${whoami.stderr}`)) throw new SetupError("Log in to Cloudflare first: npx wrangler login");
  const output = must("npx", [...WRANGLER, "deploy", "--config", WRANGLER_CONFIG, ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`])], "Couldn't deploy the hub to Cloudflare.");
  const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(output)?.[0];
  if (!url) throw new SetupError(`Deployed, but couldn't find the hub's URL in Wrangler's output:\n${output}`);
  for (const [name, value] of Object.entries(secrets)) {
    must("npx", [...WRANGLER, "secret", "put", name, "--config", WRANGLER_CONFIG], `Couldn't set the hub secret ${name}.`, value);
    console.log(`Set hub secret ${name}`);
  }
  return url;
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));
  must("gh", ["auth", "status"], "Log in to the GitHub CLI first: gh auth login");
  const login = must("gh", ["api", "user", "--jq", ".login"], "Couldn't read your GitHub login.");
  const runner = options.runner ?? `${login}/claude-autofix-runner`;
  const owners = options.owners.length ? options.owners : [login];

  const claudeToken = required(FILES.claudeToken, "your Claude token from `claude setup-token`");
  const appKey = required(FILES.appKey, "the GitHub App's private key");
  const hubSecret = savedOrNewSecret(FILES.hubSecret);
  const webhookSecret = savedOrNewSecret(FILES.webhookSecret);
  savedOrNewSecret(FILES.adminSecret);

  const url = deployHub(
    { APP_CLIENT_ID: options.clientId, APP_SLUG: options.slug, RUNNER_REPOSITORY: runner, RUNNER_WORKFLOW: "claude-autofix.yml", RUNNER_REF: "main", PERMITTED_OWNERS: owners.join(",") },
    { GITHUB_APP_PRIVATE_KEY: appKey, GITHUB_WEBHOOK_SECRET: webhookSecret, HUB_SECRET: hubSecret, ADMIN_SECRET: required(FILES.adminSecret, "the admin secret") },
  );
  save(FILES.hubUrl, url);
  console.log(`Deployed the hub at ${url}`);

  ensureRunner(runner);
  setRunnerSecrets(
    runner,
    { CLAUDE_CODE_OAUTH_TOKEN: claudeToken, CLAUDE_APP_PRIVATE_KEY: appKey, CLAUDE_AUTOFIX_HUB_SECRET: hubSecret },
    { CLAUDE_APP_CLIENT_ID: options.clientId, CLAUDE_AUTOFIX_HUB_URL: url },
  );

  console.log(`
The hub and runner are set up. Finish in the GitHub App's settings (Settings → Developer settings → GitHub Apps → ${options.slug}):

  1. Webhook: tick Active. URL: ${url}/webhook
     Secret: the contents of ${FILES.webhookSecret}
  2. Permissions & events → Subscribe to events: ${WEBHOOK_EVENTS.join(", ")}.
  3. Install the app on ${runner} and on the repositories it should work on.

Repositories owned by ${owners.join(", ")} are permitted. Permit anyone else's with:
  node scripts/hub.ts permit owner/repo`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof SetupError ? error.message : error);
  process.exitCode = 1;
}
