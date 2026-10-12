const MARKER = /<!-- (?:semgrep-findings|claude-handled): ([^>]*?) -->/;

export function handledMarker(keys: string[]): string {
  return `<!-- claude-handled: ${[...new Set(keys)].join(" ")} -->`;
}

export function keysInMarker(body: string): string[] {
  return MARKER.exec(body)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
}
