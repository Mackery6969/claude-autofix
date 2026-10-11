import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETUP_BRANCH = "claude-autofix-setup";
const WORKFLOWS = ["security", "code-quality", "claude-resume"];
const EXAMPLES = new URL("../examples/", import.meta.url);
const SECRETS = [
  { name: "CLAUDE_CODE_OAUTH_TOKEN", file: process.env.CLAUDE_AUTOFIX_TOKEN_FILE ?? join(homedir(), ".claude-autofix", "claude-oauth-token") },
  { name: "CLAUDE_APP_PRIVATE_KEY", file: process.env.CLAUDE_AUTOFIX_KEY_FILE ?? join(homedir(), ".claude-autofix", "app-private-key.pem") },
];

interface Options {
  repository: string;
  verifyCommand: string | undefined;
  workflows: boolean;
}

class SetupError extends Error {}

function parseArguments(args: string[]): Options {
  const repository = args.find((arg) => !arg.startsWith("--"));
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new SetupError('Usage: node scripts/enable-repo.ts owner/repo [--verify "npm ci && npm test"] [--secrets-only]');
  }
  const verifyIndex = args.indexOf("--verify");
  return {
    repository,
    verifyCommand: verifyIndex === -1 ? undefined : args[verifyIndex + 1],
    workflows: !args.includes("--secrets-only"),
  };
}

function gh(args: string[], input?: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("gh", args, { encoding: "utf8", input });
  if (result.error) throw new SetupError("The GitHub CLI (gh) isn't installed or isn't on PATH.");
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function ghOrFail(args: string[], failure: string): string {
  const result = gh(args);
  if (!result.ok) throw new SetupError(`${failure}\n${result.stderr}`);
  return result.stdout;
}

function setSecrets(repository: string): void {
  for (const secret of SECRETS) {
    if (!existsSync(secret.file) || readFileSync(secret.file, "utf8").trim() === "") {
      throw new SetupError(`${secret.file} is missing or empty. Save the value for ${secret.name} there (see the README).`);
    }
    const result = gh(["secret", "set", secret.name, "--repo", repository], readFileSync(secret.file, "utf8").trim());
    if (!result.ok) throw new SetupError(`Couldn't set ${secret.name} on ${repository}.\n${result.stderr}`);
    console.log(`Set ${secret.name}`);
  }
}

function workflowContent(name: string, verifyCommand: string | undefined): string {
  const template = readFileSync(new URL(`${name}.yml`, EXAMPLES), "utf8");
  return template.replace(/^(\s*)verify-command: .*\n/m, (_line, indent: string) => (verifyCommand ? `${indent}verify-command: ${JSON.stringify(verifyCommand)}\n` : ""));
}

function addWorkflows(repository: string, verifyCommand: string | undefined): void {
  const base = ghOrFail(["api", `repos/${repository}`, "--jq", ".default_branch"], `Couldn't read ${repository}.`);
  if (gh(["api", `repos/${repository}/contents/.github/workflows/security.yml?ref=${base}`, "--silent"]).ok) {
    console.log(`${repository} already has .github/workflows/security.yml, so the workflows were left alone.`);
    return;
  }
  const sha = ghOrFail(["api", `repos/${repository}/git/ref/heads/${base}`, "--jq", ".object.sha"], `Couldn't read ${base}.`);
  ghOrFail(["api", "-X", "POST", `repos/${repository}/git/refs`, "-f", `ref=refs/heads/${SETUP_BRANCH}`, "-f", `sha=${sha}`, "--silent"], `Couldn't create the ${SETUP_BRANCH} branch (does it already exist?).`);

  for (const name of WORKFLOWS) {
    const content = Buffer.from(workflowContent(name, verifyCommand)).toString("base64");
    const result = gh(["api", "-X", "PUT", `repos/${repository}/contents/.github/workflows/${name}.yml`, "-f", `message=Add ${name} workflow for Claude Autofix`, "-f", `content=${content}`, "-f", `branch=${SETUP_BRANCH}`, "--silent"]);
    if (!result.ok) {
      const hint = /workflow/i.test(result.stderr) ? "\nYour gh login can't change workflow files yet. Run: gh auth refresh -s workflow" : "";
      throw new SetupError(`Couldn't add ${name}.yml.\n${result.stderr}${hint}`);
    }
  }

  const verifyNote = verifyCommand ? `\`verify-command\` is \`${verifyCommand}\`.` : "No `verify-command` is set yet. Add one to `security.yml` and `code-quality.yml` so Claude's changes are built and tested before they're pushed.";
  const url = ghOrFail(
    ["pr", "create", "--repo", repository, "--base", base, "--head", SETUP_BRANCH, "--title", "Set up Claude Autofix", "--body", `Adds the Claude Autofix workflows: security scans and fixes, weekly code-quality passes, and resuming after usage limits.\n\n${verifyNote}`],
    "Couldn't open the setup pull request.",
  );
  console.log(`Opened ${url}`);
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));
  ghOrFail(["auth", "status"], "Log in to the GitHub CLI first: gh auth login");
  setSecrets(options.repository);
  if (options.workflows) addWorkflows(options.repository, options.verifyCommand);
  console.log(`\n${options.repository} is set up. If the Claude app isn't installed on all your repositories, add this one at https://github.com/settings/installations.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof SetupError ? error.message : error);
  process.exitCode = 1;
}
