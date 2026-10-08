import { build } from "esbuild";
import { readFileSync, rmSync } from "node:fs";

const sdkManifest = JSON.parse(readFileSync(new URL("../node_modules/@anthropic-ai/claude-agent-sdk/package.json", import.meta.url), "utf8")) as { version: string };

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  define: { CLAUDE_AGENT_SDK_VERSION: JSON.stringify(sdkManifest.version) },
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
