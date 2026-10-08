export interface PathRules {
  area: string;
  excluded: string[];
  files?: string[];
}

export function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/").replace(/^\.\/(?=.)/, "").replace(/(?<=.)\/+$/, "");
  return trimmed === "" ? "." : trimmed;
}

export function isInside(path: string, folder: string): boolean {
  const target = normalizePath(folder);
  if (target === ".") return true;
  return path === target || path.startsWith(`${target}/`);
}

export function isOffLimits(path: string, rules: PathRules): boolean {
  if (rules.files && !rules.files.includes(path)) return true;
  if (!isInside(path, rules.area)) return true;
  return rules.excluded.some((excluded) => isInside(path, excluded));
}
