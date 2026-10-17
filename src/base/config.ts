import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionFailure } from "./actions.ts";

export const CONFIG_FILE = ".github/claude-autofix.yml";

const SETTABLE = new Set([
  "tasks",
  "model",
  "max-budget-usd",
  "verify-command",
  "branch-prefix",
  "labels",
  "code-scanning-tools",
  "max-findings",
  "grouping-model",
  "time-budget-minutes",
  "issues",
  "dependabot-alerts",
  "issue-labels",
  "areas",
  "exclude",
  "extensions",
  "batch-lines",
  "pull-request-mode",
  "pull-request-authors",
  "instructions",
]);

export type RepositoryConfig = Map<string, string>;

export function parseConfig(text: string): RepositoryConfig {
  const config: RepositoryConfig = new Map();
  let listKey: string | undefined;
  let block: { key: string; indent: number; contentIndent: number | undefined; folded: boolean; lines: string[] } | undefined;
  const finishBlock = () => {
    if (block) config.set(block.key, block.folded ? block.lines.map((line) => line.trim()).filter(Boolean).join(" ") : block.lines.join("\n").trim());
    block = undefined;
  };

  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const indent = raw.length - raw.trimStart().length;
    if (block && (raw.trim() === "" || indent > block.indent)) {
      if (raw.trim() !== "") block.contentIndent ??= indent;
      block.lines.push(raw.slice(Math.min(indent, block.contentIndent ?? indent)));
      continue;
    }
    finishBlock();
    const line = stripComment(raw).trimEnd();
    if (line.trim() === "") continue;

    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const previous = config.get(listKey);
      config.set(listKey, previous ? `${previous}\n${unquote(item[1] ?? "")}` : unquote(item[1] ?? ""));
      continue;
    }

    const entry = /^([a-z][a-z0-9-]*):(?:\s+(.*))?$/.exec(line);
    if (!entry?.[1] || indent > 0) throw new ActionFailure(`${CONFIG_FILE} line ${index + 1} isn't "key: value" or a "- item" under a key.`);
    const [, key, value = ""] = entry;
    if (!SETTABLE.has(key)) throw new ActionFailure(`${CONFIG_FILE} line ${index + 1}: "${key}" can't be set here. Settable keys: ${[...SETTABLE].join(", ")}.`);
    listKey = undefined;
    if (value === "|" || value === ">") {
      block = { key, indent, contentIndent: undefined, folded: value === ">", lines: [] };
    } else if (value === "") {
      listKey = key;
      config.set(key, "");
    } else {
      config.set(key, value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1).split(",").map(unquote).join("\n") : unquote(value));
    }
  }
  finishBlock();
  return config;
}

export function readConfig(workspace: string): RepositoryConfig {
  let text: string;
  try {
    text = readFileSync(join(workspace, CONFIG_FILE), "utf8");
  } catch {
    return new Map();
  }
  return parseConfig(text);
}

export function applyConfig(config: RepositoryConfig, environment: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of config) environment[`INPUT_${key.toUpperCase()}`] = value;
}

export function taskEnabled(config: RepositoryConfig, task: string): boolean {
  const tasks = config.get("tasks");
  if (tasks === undefined) return true;
  return tasks.split(/[\n,]/).map((name) => name.trim()).includes(task);
}

function stripComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0]) {
    const inner = trimmed.slice(1, -1);
    return trimmed[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  return trimmed;
}
