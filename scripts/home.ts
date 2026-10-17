import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HOME = process.env.CLAUDE_AUTOFIX_HOME ?? join(homedir(), ".claude-autofix");

export const FILES = {
  claudeToken: process.env.CLAUDE_AUTOFIX_TOKEN_FILE ?? join(HOME, "claude-oauth-token"),
  appKey: process.env.CLAUDE_AUTOFIX_KEY_FILE ?? join(HOME, "app-private-key.pem"),
  hubUrl: join(HOME, "hub-url"),
  hubSecret: join(HOME, "hub-secret"),
  adminSecret: join(HOME, "admin-secret"),
  webhookSecret: join(HOME, "webhook-secret"),
};

export function readSaved(path: string): string | undefined {
  const file = [path, `${path}.txt`].find((candidate) => existsSync(candidate) && readFileSync(candidate, "utf8").trim() !== "");
  return file ? readFileSync(file, "utf8").trim() : undefined;
}

export function save(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
}

export function savedOrNewSecret(path: string): string {
  const existing = readSaved(path);
  if (existing) return existing;
  const secret = randomBytes(32).toString("hex");
  save(path, secret);
  return secret;
}
