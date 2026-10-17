import { createHmac } from "node:crypto";

export const SIGNATURE_HEADER = "X-Autofix-Signature";

export interface HubJob {
  repository: string;
  task: string;
  ref: string;
  sha: string;
  pullRequest: number | undefined;
  issue?: number | undefined;
  before?: string;
  sender: string;
}

export interface Hub {
  url: string;
  secret: string;
  job: HubJob;
  cursor: string;
}

export type HubReport = { kind: "paused"; resumeAt: string } | { kind: "cursor"; cursor: string; lapDone?: boolean } | { kind: "queue"; task: "security" | "quality"; ref: string };

export function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export async function reportToHub(hub: Hub, report: HubReport): Promise<void> {
  const body = JSON.stringify({ job: hub.job, ...report });
  const response = await fetch(`${hub.url.replace(/\/+$/, "")}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [SIGNATURE_HEADER]: sign(hub.secret, body) },
    body,
  });
  if (!response.ok) throw new Error(`the hub answered HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
}
