import { notice, setOutput, summary, warn } from "./actions.ts";
import { reportToHub, type Hub } from "./hub.ts";
import { describeLimit, type UsageLimit } from "./limits.ts";

const MARGIN_MS = 2 * 60 * 1000;

export async function pauseRun(usage: UsageLimit, hub: Hub | undefined): Promise<void> {
  const resumeAt = new Date(usage.resetsAt.getTime() + MARGIN_MS);
  const when = resumeAt.toUTCString();
  notice(`Claude ${describeLimit(usage.type)} reached; nothing was changed. Resuming after ${when}.`);
  setOutput("paused", true);
  setOutput("resume-at", resumeAt.toISOString());
  if (!hub) {
    summary(`## Paused: Claude ${describeLimit(usage.type)} reached\n\nNothing was changed. No hub is set, so start this again by hand after **${when}**.`);
    return;
  }
  try {
    await reportToHub(hub, { kind: "paused", resumeAt: resumeAt.toISOString() });
    summary(`## Paused: Claude ${describeLimit(usage.type)} reached\n\nNothing was changed. The hub holds every repository's work until **${when}**, then starts this again.`);
  } catch (error) {
    warn(`Couldn't tell the hub about the pause (${error instanceof Error ? error.message : String(error)}). The next scheduled run picks this up after ${when}.`);
  }
}
