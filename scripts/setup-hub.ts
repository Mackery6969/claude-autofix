import { FILES, savedOrNewSecret } from "./home.ts";
import { ACTION_REPOSITORY, must, run, setOnRepository, SetupError } from "./hub-deploy.ts";

const WEBHOOK_EVENTS = ["Code scanning alert", "Dependabot alert", "Issues", "Pull request"];
const NEW_PERMISSIONS = ["Secrets", "Variables"];

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function cloudflareAccountId(given: string | undefined): string {
  if (given) return given;
  const whoami = run("npx", ["--yes", "wrangler@4", "whoami"]);
  if (!whoami.ok || /not authenticated|not logged in/i.test(`${whoami.stdout}\n${whoami.stderr}`)) throw new SetupError("Log in to Cloudflare first (npx wrangler login), or pass --account-id.");
  const accounts = [...new Set(whoami.stdout.match(/\b[0-9a-f]{32}\b/g) ?? [])];
  if (accounts.length !== 1) throw new SetupError(`Found ${accounts.length} Cloudflare accounts; pick one with --account-id.`);
  return accounts[0] ?? "";
}

function main(): void {
  const args = process.argv.slice(2);
  const clientId = option(args, "--client-id");
  if (!clientId) throw new SetupError("Usage: node scripts/setup-hub.ts --client-id <app client ID> [--runner owner/claude-autofix-runner] [--owners you,your-org] [--account-id <Cloudflare account>]");

  must("gh", ["auth", "status"], "Log in to the GitHub CLI first: gh auth login");
  const login = must("gh", ["api", "user", "--jq", ".login"], "Couldn't read your GitHub login.");
  const runner = option(args, "--runner") ?? `${login}/claude-autofix-runner`;
  const owners = (option(args, "--owners") ?? login).split(",").map((owner) => owner.trim()).filter(Boolean);
  if (runner.split("/")[0]?.toLowerCase() !== ACTION_REPOSITORY.split("/")[0]?.toLowerCase()) throw new SetupError(`The runner must belong to the same account as ${ACTION_REPOSITORY}, so one app token can update both.`);

  if (!run("gh", ["repo", "view", runner, "--json", "name"]).ok) {
    must("gh", ["repo", "create", runner, "--private", "--add-readme", "--description", "Runs Claude Autofix for the repositories the hub permits."], `Couldn't create ${runner}.`);
    console.log(`Created the private runner repository ${runner}`);
  }

  setOnRepository(
    ACTION_REPOSITORY,
    {
      CLAUDE_AUTOFIX_HUB_SECRET: savedOrNewSecret(FILES.hubSecret),
      CLAUDE_AUTOFIX_WEBHOOK_SECRET: savedOrNewSecret(FILES.webhookSecret),
      CLAUDE_AUTOFIX_ADMIN_SECRET: savedOrNewSecret(FILES.adminSecret),
    },
    { CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId(option(args, "--account-id")), CLAUDE_APP_CLIENT_ID: clientId, CLAUDE_AUTOFIX_RUNNER: runner, CLAUDE_AUTOFIX_OWNERS: owners.join(",") },
  );

  console.log(`
Secrets and settings are on ${ACTION_REPOSITORY}. Before the first deploy, in the GitHub App's settings:

  1. Permissions & events → Repository permissions: give ${NEW_PERMISSIONS.join(" and ")} read and write, so deploys can update ${runner}.
     Then accept the new permissions under Settings → Applications → Installed GitHub Apps.
  2. Install the app on ${runner} (if it isn't on all repositories).

Then deploy (every release does this too):
  gh workflow run hub.yml --repo ${ACTION_REPOSITORY}

When it's done, its summary shows the hub's URL. Finish the app's settings:

  3. Webhook: tick Active. URL: <hub URL>/webhook
     Secret: the contents of ${FILES.webhookSecret}
  4. Subscribe to events: ${WEBHOOK_EVENTS.join(", ")}.

Repositories owned by ${owners.join(", ")} are permitted. Permit anyone else's with:
  node scripts/hub.ts permit owner/repo`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof SetupError ? error.message : error);
  process.exitCode = 1;
}
