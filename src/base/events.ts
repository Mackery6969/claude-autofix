import { eventPayload } from "./actions.ts";

const SUPPORTED_EVENTS = ["workflow_run", "issues", "pull_request", "push", "schedule", "workflow_dispatch"];
const STARTED_ON_PURPOSE = ["schedule", "workflow_dispatch"];

export interface TriggerEvent {
  name: string;
  action: string;
  sender: string;
}

export function triggerEvent(): TriggerEvent {
  const payload = eventPayload<{ action?: string; sender?: { login?: string } }>();
  return { name: process.env.GITHUB_EVENT_NAME ?? "", action: payload?.action ?? "", sender: payload?.sender?.login ?? "" };
}

export function whyIgnored(event: TriggerEvent, self: string): string | undefined {
  if (!SUPPORTED_EVENTS.includes(event.name)) return `${event.name || "this"} events never start Claude, so comments and reviews can't set it off`;
  if (STARTED_ON_PURPOSE.includes(event.name) || event.action === "closed") return undefined;
  if (event.sender.toLowerCase() === self.toLowerCase()) return `${self} caused this ${event.name} event, and Claude doesn't react to its own work`;
  return undefined;
}
