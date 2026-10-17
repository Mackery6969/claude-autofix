import { ACTION_REPOSITORY, deployWorker, putWorkerSecrets, RUNNER_WORKFLOW, setOnRepository, SetupError, writeRunnerWorkflow } from "./hub-deploy.ts";

function setting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new SetupError(`${name} isn't set. Run node scripts/setup-hub.ts once to set the secrets and variables the hub is deployed with.`);
  return value;
}

try {
  const runner = setting("CLAUDE_AUTOFIX_RUNNER");
  const hubSecret = setting("CLAUDE_AUTOFIX_HUB_SECRET");
  const appKey = setting("CLAUDE_APP_PRIVATE_KEY");
  const url = deployWorker({ clientId: setting("CLAUDE_APP_CLIENT_ID"), slug: setting("CLAUDE_APP_SLUG"), runner, owners: setting("CLAUDE_AUTOFIX_OWNERS").split(",") });
  console.log(`Deployed the hub at ${url}`);
  putWorkerSecrets({ GITHUB_APP_PRIVATE_KEY: appKey, GITHUB_WEBHOOK_SECRET: setting("CLAUDE_AUTOFIX_WEBHOOK_SECRET"), HUB_SECRET: hubSecret, ADMIN_SECRET: setting("CLAUDE_AUTOFIX_ADMIN_SECRET") });
  console.log("Set the hub's secrets");

  console.log(writeRunnerWorkflow(runner) ? `Updated ${RUNNER_WORKFLOW} in ${runner}` : `${runner} already has the current runner workflow`);
  setOnRepository(runner, { CLAUDE_CODE_OAUTH_TOKEN: setting("CLAUDE_CODE_OAUTH_TOKEN"), CLAUDE_APP_PRIVATE_KEY: appKey, CLAUDE_AUTOFIX_HUB_SECRET: hubSecret }, { CLAUDE_APP_CLIENT_ID: setting("CLAUDE_APP_CLIENT_ID"), CLAUDE_AUTOFIX_HUB_URL: url });
  setOnRepository(ACTION_REPOSITORY, {}, { CLAUDE_AUTOFIX_HUB_URL: url });
  console.log(`::notice title=Claude Autofix hub::Webhook URL for the app: ${url}/webhook`);
} catch (error) {
  console.error(error instanceof SetupError ? error.message : error);
  process.exitCode = 1;
}
