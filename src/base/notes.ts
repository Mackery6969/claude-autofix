export const WAITING_MARKER = "<!-- claude-autofix:waiting -->";

export function waitingNote(resumeAt: Date): string {
  const when = `${resumeAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `I've hit my Claude usage limit, so I can't answer yet. I'll pick this up after **${when}**; there's no need to comment again.\n\n${WAITING_MARKER}`;
}
