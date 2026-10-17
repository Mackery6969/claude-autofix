import { createHmac } from "node:crypto";
import { FILES, readSaved } from "./home.ts";

const USAGE = `Usage:
  node scripts/hub.ts list
  node scripts/hub.ts permit owner/repo
  node scripts/hub.ts revoke owner/repo
  node scripts/hub.ts run owner/repo [security|quality] [branch]`;

async function main(): Promise<void> {
  const [action, repository, task, ref] = process.argv.slice(2);
  if (!action || !["list", "permit", "revoke", "run"].includes(action) || (action !== "list" && !repository)) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const url = readSaved(FILES.hubUrl);
  const secret = readSaved(FILES.adminSecret);
  if (!url || !secret) {
    console.error(`No hub is set up yet (${FILES.hubUrl} and ${FILES.adminSecret}). Run: node scripts/setup-hub.ts`);
    process.exitCode = 1;
    return;
  }
  const body = JSON.stringify({ action, repository, task, ref });
  const response = await fetch(`${url.replace(/\/+$/, "")}/admin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Autofix-Signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` },
    body,
  });
  console.log(await response.text());
  if (!response.ok) process.exitCode = 1;
}

await main();
