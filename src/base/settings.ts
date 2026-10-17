export const CONFIG_FILE = ".github/claude-autofix.yml";

export const TASKS = ["security", "fix", "scan", "quality", "conversation"] as const;
export type TaskName = (typeof TASKS)[number];

const SETTABLE = new Set([
  "tasks",
  "security-every",
  "fix-every",
  "quality-every",
  "scan-every",
  "scan-on-push",
  "scan-paths",
  "scan-branches",
  "scan-lines",
  "scan-batches",
  "scan-pace",
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

export const DEFAULT_EVERY = { security: "6h", fix: "6h", scan: "7d", quality: "7d" } as const;
const MINIMUM_EVERY_MS = 15 * 60_000;
const UNITS: Record<string, number> = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000, w: 7 * 24 * 60 * 60_000 };

export class ConfigError extends Error {}

export type RepositoryConfig = Map<string, string>;

export interface HubSettings {
  tasks: TaskName[];
  every: Record<keyof typeof DEFAULT_EVERY, number | undefined>;
  scanOnPush: boolean;
  scanPaths: string[];
  scanBranches: string[];
  scanPace: number;
}

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
    if (!entry?.[1] || indent > 0) throw new ConfigError(`${CONFIG_FILE} line ${index + 1} isn't "key: value" or a "- item" under a key.`);
    const [, key, value = ""] = entry;
    if (!SETTABLE.has(key)) throw new ConfigError(`${CONFIG_FILE} line ${index + 1}: "${key}" can't be set here. Settable keys: ${[...SETTABLE].join(", ")}.`);
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

export function list(value: string | undefined): string[] {
  return (value ?? "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

export function taskEnabled(config: RepositoryConfig, task: TaskName): boolean {
  const tasks = config.get("tasks");
  return tasks === undefined || list(tasks).includes(task);
}

function flag(value: string | undefined): boolean {
  return /^(true|yes|on|1)$/i.test(value?.trim() ?? "");
}

export function parseEvery(value: string): number | undefined {
  if (/^(off|never|no|false)$/i.test(value.trim())) return undefined;
  const match = /^(\d+)\s*([mhdw])$/i.exec(value.trim());
  if (!match) throw new ConfigError(`"${value}" isn't an interval: use something like 30m, 6h, 1d or 2w, or off.`);
  const ms = Number(match[1]) * (UNITS[(match[2] ?? "").toLowerCase()] ?? 0);
  if (ms < MINIMUM_EVERY_MS) throw new ConfigError(`"${value}" is too often: the shortest interval is 15m.`);
  return ms;
}

export function hubSettings(config: RepositoryConfig): HubSettings {
  const every = (task: keyof typeof DEFAULT_EVERY) => (taskEnabled(config, task) ? parseEvery(config.get(`${task}-every`) ?? DEFAULT_EVERY[task]) : undefined);
  return {
    tasks: TASKS.filter((task) => taskEnabled(config, task)),
    every: { security: every("security"), fix: every("fix"), scan: every("scan"), quality: every("quality") },
    scanOnPush: taskEnabled(config, "scan") && flag(config.get("scan-on-push")),
    scanPaths: list(config.get("scan-paths")),
    scanBranches: list(config.get("scan-branches")),
    scanPace: parseEvery(config.get("scan-pace") ?? "1h") ?? 60 * 60_000,
  };
}

export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  const source = glob.trim().replace(/^\.\//, "");
  for (let index = 0; index < source.length; index++) {
    const character = source[index] ?? "";
    if (character === "*" && source[index + 1] === "*") {
      const slash = source[index + 2] === "/";
      pattern += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (character === "*") pattern += "[^/]*";
    else if (character === "?") pattern += "[^/]";
    else pattern += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(source.includes("/") ? `^${pattern}$` : `(^|/)${pattern}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.length === 0 || globs.some((glob) => globToRegExp(glob).test(path));
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
