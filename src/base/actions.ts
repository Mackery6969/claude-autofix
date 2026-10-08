import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

export class ActionFailure extends Error {}

export function input(name: string, fallback = ""): string {
  const value = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

export function multilineInput(name: string): string[] {
  return input(name)
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function booleanInput(name: string, fallback = false): boolean {
  const value = input(name).toLowerCase();
  if (value === "") return fallback;
  return value === "true" || value === "yes" || value === "1";
}

export function numberInput(name: string, fallback: number): number {
  const value = Number(input(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const escapeData = (text: string) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (text: string) => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

export function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function notice(message: string, title?: string): void {
  const properties = title ? ` title=${escapeProperty(title)}` : "";
  process.stdout.write(`::notice${properties}::${escapeData(message)}\n`);
}

export function warn(message: string): void {
  process.stdout.write(`::warning::${escapeData(message)}\n`);
}

export function fail(message: string): void {
  process.stdout.write(`::error::${escapeData(message)}\n`);
  process.exitCode = 1;
}

export function mask(secret: string): void {
  if (secret) process.stdout.write(`::add-mask::${secret}\n`);
}

export function setOutput(name: string, value: string | number | boolean): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

export function summary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

export function startUntrustedOutput(title: string): () => void {
  const resumeToken = randomUUID().replace(/-/g, "");
  log(`::group::${title}`);
  log(`::stop-commands::${resumeToken}`);
  return () => {
    log(`::${resumeToken}::`);
    log("::endgroup::");
  };
}

export function untrustedOutput(title: string, write: () => void): void {
  const end = startUntrustedOutput(title);
  try {
    write();
  } finally {
    end();
  }
}

export function eventPayload<T>(): T | undefined {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ActionFailure(`${name} is not set. This action only runs inside GitHub Actions.`);
  return value;
}
