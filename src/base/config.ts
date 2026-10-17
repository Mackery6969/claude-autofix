import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionFailure } from "./actions.ts";
import { CONFIG_FILE, ConfigError, parseConfig, type RepositoryConfig } from "./settings.ts";

export { CONFIG_FILE, parseConfig, taskEnabled, type RepositoryConfig } from "./settings.ts";

export function readConfig(workspace: string): RepositoryConfig {
  let text: string;
  try {
    text = readFileSync(join(workspace, CONFIG_FILE), "utf8");
  } catch {
    return new Map();
  }
  try {
    return parseConfig(text);
  } catch (error) {
    if (error instanceof ConfigError) throw new ActionFailure(error.message);
    throw error;
  }
}

export function applyConfig(config: RepositoryConfig, environment: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of config) environment[`INPUT_${key.toUpperCase()}`] = value;
}
