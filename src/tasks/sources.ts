import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { git } from "../base/git.ts";
import { isInside } from "../base/paths.ts";

export const SOURCE_EXTENSIONS = [
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte",
  "py", "rb", "php", "lua", "gml", "gd", "dart",
  "java", "kt", "kts", "scala", "groovy", "gradle",
  "cs", "fs", "vb", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm", "swift",
  "go", "rs", "ex", "exs", "erl", "hs", "clj",
  "sh", "bash", "zsh", "ps1", "psm1", "sql",
];

const GENERATED_OR_VENDORED = [
  /(^|\/)(node_modules|vendor|third_party|third-party|dist|build|out|generated|\.gradle)\//,
  /\.min\.[cm]?js$/,
  /\.d\.ts$/,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|gradlew|gradlew\.bat)$/,
];

export interface SourceFile {
  path: string;
  lines: number;
}

export interface SourceScope {
  areas: string[];
  exclude: string[];
  extensions: string[];
}

export interface Batch {
  files: SourceFile[];
  cursor: string;
  wrapped: boolean;
}

export function isSourcePath(path: string, scope: SourceScope): boolean {
  const extension = extname(path).slice(1).toLowerCase();
  if (!scope.extensions.includes(extension)) return false;
  if (GENERATED_OR_VENDORED.some((pattern) => pattern.test(path))) return false;
  if (scope.areas.length > 0 && !scope.areas.some((area) => isInside(path, area))) return false;
  return !scope.exclude.some((excluded) => isInside(path, excluded));
}

export function readSourceFile(cwd: string, path: string): SourceFile | undefined {
  let content: Buffer;
  try {
    content = readFileSync(join(cwd, path));
  } catch {
    return undefined;
  }
  if (content.subarray(0, 8000).includes(0)) return undefined;
  const text = content.toString("utf8");
  const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  return { path, lines };
}

export function listSourceFiles(cwd: string, scope: SourceScope): SourceFile[] {
  const tracked = git(["ls-files", "-z"], { cwd }).split("\0").filter(Boolean);
  return tracked
    .filter((path) => isSourcePath(path, scope))
    .sort(comparePaths)
    .map((path) => readSourceFile(cwd, path))
    .filter((file): file is SourceFile => file !== undefined && file.lines > 0);
}

export function nextBatch(files: SourceFile[], cursor: string, maxLines: number): Batch {
  if (files.length === 0) return { files: [], cursor, wrapped: false };
  const resumeAt = cursor ? files.findIndex((file) => comparePaths(file.path, cursor) > 0) : 0;
  const start = resumeAt === -1 ? 0 : resumeAt;
  const { taken } = takeUpTo(files.slice(start), maxLines);
  return { files: taken, cursor: taken.at(-1)?.path ?? cursor, wrapped: resumeAt === -1 };
}

export function takeUpTo(files: SourceFile[], maxLines: number): { taken: SourceFile[]; skipped: SourceFile[] } {
  const taken: SourceFile[] = [];
  let total = 0;
  for (const file of files) {
    if (taken.length > 0 && total + file.lines > maxLines) break;
    taken.push(file);
    total += file.lines;
  }
  return { taken, skipped: files.slice(taken.length) };
}

export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
