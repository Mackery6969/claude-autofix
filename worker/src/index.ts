import { encodeRef, GitHubApiError, GitHubApp } from "./github.ts";
import { effectsOf, isClaudeBranch, isIgnored, type Effect, type Job, type Task, type WebhookPayload } from "./routing.ts";
import { CONFIG_FILE, ConfigError, hubSettings, matchesAny, parseConfig, type HubSettings } from "../../src/base/settings.ts";
import { dueJobs, newRecord, scheduledWork, type RepositoryRecord } from "./schedule.ts";
import { GITHUB_SIGNATURE_HEADER, REPORT_SIGNATURE_HEADER, verifySignature } from "./signatures.ts";
import { State, type KeyValueStore } from "./state.ts";

export interface Env {
  STATE: KeyValueStore;
  APP_CLIENT_ID: string;
  APP_SLUG: string;
  RUNNER_REPOSITORY: string;
  RUNNER_WORKFLOW: string;
  RUNNER_REF: string;
  PERMITTED_OWNERS: string;
  IGNORED_REPOSITORIES: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  HUB_SECRET: string;
  ADMIN_SECRET: string;
}

interface ScheduledEvent {
  scheduledTime: number;
}

interface HubReport {
  job: { repository: string; task: string; ref: string; sha: string; before?: string; pullRequest?: number; issue?: number; sender: string };
  kind: "paused" | "cursor" | "queue";
  resumeAt?: string;
  cursor?: string;
  lapDone?: boolean;
  task?: string;
  ref?: string;
}

interface AdminRequest {
  action: "permit" | "revoke" | "list" | "run" | "sync";
  repository?: string;
  task?: Task;
  ref?: string;
}

const DISPATCHES_PER_TICK = 3;
const SYNC_EVERY_MS = 24 * 60 * 60_000;
const RETRY_AFTER_MS = 15 * 60_000;
const TASKS = new Set<string>(["security", "fix", "scan", "quality", "conversation"]);
const QUEUEABLE = new Set<string>(["security", "fix", "scan", "quality"]);
const PUSH_SETTLE_MS = 2 * 60_000;

class Hub {
  readonly env: Env;
  readonly state: State;
  readonly app: GitHubApp;

  constructor(env: Env) {
    this.env = env;
    this.state = new State(env.STATE);
    this.app = new GitHubApp({ clientId: env.APP_CLIENT_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY });
  }

  get owners(): string[] {
    return (this.env.PERMITTED_OWNERS ?? "").split(/[\s,]+/).filter(Boolean);
  }

  get ignored(): string[] {
    return [this.env.RUNNER_REPOSITORY, ...(this.env.IGNORED_REPOSITORIES ?? "").split(/[\s,]+/)].filter(Boolean);
  }

  async permitted(repository: string): Promise<boolean> {
    if (isIgnored(repository, this.ignored)) return false;
    return this.state.permitted(repository, this.owners);
  }

  async apply(effect: Effect, now: number): Promise<void> {
    switch (effect.kind) {
      case "register":
        for (const { repository, defaultBranch } of effect.repositories) await this.register(repository, effect.installation, defaultBranch, now);
        return;
      case "unregister":
        for (const repository of effect.repositories) await this.state.forgetRepository(repository);
        return;
      case "enqueue": {
        if (!(await this.permitted(effect.job.repository))) return;
        const job = await this.resolve(effect.job);
        if (job && (await this.state.settings(job.repository)).tasks.includes(job.task)) await this.state.enqueue(job);
        return;
      }
      case "push":
        if (await this.permitted(effect.repository)) await this.push(effect, now);
        return;
      case "delete-branch":
        if (await this.permitted(effect.repository)) await this.deleteBranch(effect);
        return;
    }
  }

  async claudeTookPart(job: Job, number: number): Promise<boolean> {
    const bot = `${this.env.APP_SLUG}[bot]`.toLowerCase();
    const thread = await this.app.as<{ user: { login: string } | null }>(job.installation, "GET", `/repos/${job.repository}/issues/${number}`);
    if (thread.user?.login.toLowerCase() === bot) return true;
    const comments = await this.app.as<Array<{ user: { login: string } | null }>>(job.installation, "GET", `/repos/${job.repository}/issues/${number}/comments?per_page=100`);
    return comments.some((comment) => comment.user?.login.toLowerCase() === bot);
  }

  async resolve(job: Job): Promise<Job | undefined> {
    if (job.task === "conversation" && job.issue) return job.mentioned || (await this.claudeTookPart(job, job.issue)) ? job : undefined;
    if (!job.pullRequest || job.ref) return job;
    const pull = await this.app.as<{ state: string; head: { ref: string; sha: string; repo: { full_name: string } | null } }>(job.installation, "GET", `/repos/${job.repository}/pulls/${job.pullRequest}`);
    const claudes = isClaudeBranch(pull.head.ref) && pull.head.repo?.full_name === job.repository;
    if (job.task === "conversation") return claudes || job.mentioned || (await this.claudeTookPart(job, job.pullRequest)) ? job : undefined;
    if ((job.task === "security" || job.task === "fix") && claudes) return pull.state === "open" ? { ...job, task: "conversation", ref: pull.head.ref, sha: pull.head.sha } : undefined;
    return job;
  }

  async register(repository: string, installation: number, defaultBranch: string | undefined, now: number): Promise<void> {
    const existing = await this.state.repository(repository);
    if (existing && existing.installation === installation && (!defaultBranch || existing.defaultBranch === defaultBranch)) return;
    const branch = defaultBranch ?? existing?.defaultBranch ?? (await this.app.as<{ default_branch: string }>(installation, "GET", `/repos/${repository}`)).default_branch;
    await this.state.saveRepository(existing ? { ...existing, installation, defaultBranch: branch } : newRecord(repository, installation, branch, now));
    await this.refreshSettings(repository, installation, branch);
  }

  async refreshSettings(repository: string, installation: number, branch: string): Promise<HubSettings> {
    let settings = hubSettings(new Map());
    try {
      const file = await this.app.as<{ content: string }>(installation, "GET", `/repos/${repository}/contents/${CONFIG_FILE}?ref=${encodeURIComponent(branch)}`);
      settings = hubSettings(parseConfig(new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s+/g, "")), (character) => character.charCodeAt(0)))));
    } catch (error) {
      if (error instanceof ConfigError) console.log(`${repository}: ${error.message} Using the defaults until it's fixed.`);
      else if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
    }
    await this.state.saveSettings(repository, settings);
    return settings;
  }

  async push(effect: Extract<Effect, { kind: "push" }>, now: number): Promise<void> {
    const onDefaultBranch = effect.branch === effect.defaultBranch;
    const settings = onDefaultBranch && effect.paths.includes(CONFIG_FILE) ? await this.refreshSettings(effect.repository, effect.installation, effect.branch) : await this.state.settings(effect.repository);
    if (!settings.scanOnPush) return;
    if (settings.scanBranches.length && !matchesAny(effect.branch, settings.scanBranches)) return;
    if (effect.paths.length && settings.scanPaths.length && !effect.paths.some((path) => matchesAny(path, settings.scanPaths))) return;
    await this.state.enqueue({ repository: effect.repository, installation: effect.installation, task: "scan", ref: effect.branch, sha: effect.after, before: effect.before, pullRequest: undefined, issue: undefined, sender: effect.sender, due: now + PUSH_SETTLE_MS });
  }

  async deleteBranch(effect: Extract<Effect, { kind: "delete-branch" }>): Promise<void> {
    try {
      const ref = await this.app.as<{ object: { sha: string } }>(effect.installation, "GET", `/repos/${effect.repository}/git/ref/heads/${encodeRef(effect.branch)}`);
      if (ref.object.sha !== effect.sha) return;
      await this.app.as(effect.installation, "DELETE", `/repos/${effect.repository}/git/refs/heads/${encodeRef(effect.branch)}`);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || (error.status !== 404 && error.status !== 422)) throw error;
    }
  }

  async sync(now: number): Promise<string[]> {
    const seen: string[] = [];
    for (const installation of await this.app.installations()) {
      for (const repository of await this.app.repositories(installation)) {
        if (repository.archived || isIgnored(repository.full_name, this.ignored)) continue;
        await this.register(repository.full_name, installation, repository.default_branch, now);
        await this.refreshSettings(repository.full_name, installation, repository.default_branch).catch((error: unknown) => console.log(`Couldn't read ${repository.full_name}'s settings: ${error instanceof Error ? error.message : String(error)}`));
        seen.push(repository.full_name);
      }
    }
    for (const record of await this.state.repositories()) if (!seen.includes(record.repository)) await this.state.forgetRepository(record.repository);
    await this.state.synced(now);
    return seen;
  }

  async tick(now: number): Promise<string[]> {
    const log: string[] = [];
    if (now - (await this.state.lastSync()) >= SYNC_EVERY_MS) log.push(`Synced ${(await this.sync(now)).length} installed repositories.`);
    for (const record of await this.state.repositories()) {
      if (!(await this.permitted(record.repository))) continue;
      const work = scheduledWork(record, now, await this.state.settings(record.repository));
      for (const job of work.jobs) await this.state.enqueue(job);
      if (work.record !== record) await this.state.saveRepository(work.record);
    }

    const pause = await this.state.pause();
    if (pause && pause.until > now) {
      log.push(`Paused on a usage limit until ${new Date(pause.until).toISOString()}.`);
      return log;
    }

    const due = dueJobs(await this.state.jobs(), now, DISPATCHES_PER_TICK);
    if (due.length === 0) return log;
    const runnerInstallation = await this.app.installationFor(this.env.RUNNER_REPOSITORY);
    for (const job of due) {
      if (!(await this.permitted(job.repository))) {
        await this.state.finish(job);
        continue;
      }
      try {
        await this.dispatch(runnerInstallation, job);
        await this.state.finish(job);
        log.push(`Dispatched ${job.task} for ${job.repository}${job.pullRequest ? ` #${job.pullRequest}` : ` on ${job.ref}`}.`);
      } catch (error) {
        await this.state.postpone(job, now + RETRY_AFTER_MS);
        log.push(`Couldn't dispatch ${job.task} for ${job.repository}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return log;
  }

  async dispatch(runnerInstallation: number, job: Job): Promise<void> {
    const record = await this.state.repository(job.repository);
    const onDefaultBranch = !job.pullRequest && job.ref === record?.defaultBranch;
    let { sha, sender } = job;
    if (job.task !== "conversation" && !job.pullRequest && !onDefaultBranch && (!sha || !sender)) {
      const commit = await this.app.as<{ sha: string; author: { login: string } | null; committer: { login: string } | null }>(job.installation, "GET", `/repos/${job.repository}/commits/${encodeURIComponent(sha || job.ref)}`);
      sha ||= commit.sha;
      sender ||= commit.author?.login ?? commit.committer?.login ?? "";
    }
    const inputs: Record<string, string> = { repository: job.repository, task: job.task, ref: job.ref, sha, before: job.before ?? "", "pull-request": job.pullRequest ? String(job.pullRequest) : "", issue: job.issue ? String(job.issue) : "", sender };
    if ((job.task === "quality" || job.task === "scan") && onDefaultBranch && !job.before) inputs.cursor = await this.state.cursor(job.repository, job.task);
    await this.app.as(runnerInstallation, "POST", `/repos/${this.env.RUNNER_REPOSITORY}/actions/workflows/${encodeURIComponent(this.env.RUNNER_WORKFLOW)}/dispatches`, { ref: this.env.RUNNER_REF || "main", inputs });
  }

  async report(report: HubReport, now: number): Promise<Response> {
    const { job } = report;
    if (!TASKS.has(job.task)) return text("Unknown task.", 400);
    const record = await this.state.repository(job.repository);
    if (!record || !(await this.permitted(job.repository))) return text("That repository isn't permitted.", 403);
    if (report.kind === "queue") {
      if (!QUEUEABLE.has(report.task ?? "")) return text("Only security sweeps, fixes, scans and quality passes can be queued.", 400);
      if (!(await this.state.settings(job.repository)).tasks.includes(report.task as Task)) return text(`${report.task} is turned off for that repository.`, 409);
      const ref = report.ref?.trim() || record.defaultBranch;
      await this.state.enqueue({ repository: job.repository, installation: record.installation, task: report.task as Task, ref, sha: "", pullRequest: undefined, issue: undefined, sender: job.sender, due: now });
      return text("Queued.", 200);
    }
    if (report.kind === "cursor" && typeof report.cursor === "string") {
      await this.state.saveCursor(job.repository, job.task, report.cursor);
      if (job.task === "scan") await this.continueLap(record, report.lapDone === true, now);
      return text("Saved.", 200);
    }
    const until = Date.parse(report.resumeAt ?? "");
    if (report.kind !== "paused" || Number.isNaN(until)) return text("Unknown report.", 400);
    await this.state.pauseUntil(until);
    await this.state.enqueue({ repository: job.repository, installation: record.installation, task: job.task as Task, ref: job.ref, sha: job.sha, ...(job.before ? { before: job.before } : {}), pullRequest: job.pullRequest || undefined, issue: job.issue || undefined, sender: job.sender, due: until });
    return text("Paused.", 200);
  }

  async continueLap(record: RepositoryRecord, lapDone: boolean, now: number): Promise<void> {
    const next: Job = { repository: record.repository, installation: record.installation, task: "scan", ref: record.defaultBranch, sha: "", pullRequest: undefined, issue: undefined, sender: "", due: now };
    if (lapDone) return this.state.finish(next);
    const settings = await this.state.settings(record.repository);
    if (settings.tasks.includes("scan")) await this.state.enqueue({ ...next, due: now + settings.scanPace });
  }

  async admin(request: AdminRequest, now: number): Promise<Response> {
    const repository = request.repository?.trim() ?? "";
    if (request.action === "list") {
      const records = await this.state.repositories();
      const rows = await Promise.all(records.map(async (record) => ({ repository: record.repository, permitted: await this.permitted(record.repository) })));
      const pause = await this.state.pause();
      return json({ owners: this.owners, permits: await this.state.permits(), repositories: rows, queued: (await this.state.jobs()).map(({ repository: name, task, ref, pullRequest, due }) => ({ repository: name, task, ref, pullRequest, due: new Date(due).toISOString() })), pausedUntil: pause && pause.until > now ? new Date(pause.until).toISOString() : null });
    }
    if (request.action === "sync") {
      const seen = await this.sync(now);
      const permitted = await Promise.all(seen.map(async (name) => `${name}${(await this.permitted(name)) ? "" : " (not permitted)"}`));
      return text(`The app is installed on ${seen.length} repositories:\n${permitted.join("\n")}`, 200);
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) return text("Give a repository as owner/name.", 400);
    if (request.action === "permit") {
      await this.state.permit(repository);
      return text(`Permitted ${repository}.`, 200);
    }
    if (request.action === "revoke") {
      await this.state.revoke(repository);
      return text(`Revoked ${repository}; its queued work was dropped.`, 200);
    }
    if (request.action === "run") {
      const record = await this.state.repository(repository);
      if (!record) return text(`${repository} hasn't been seen yet. Install the app on it first.`, 404);
      if (!(await this.permitted(repository))) return text(`${repository} isn't permitted.`, 403);
      const task = request.task ?? "security";
      if (!TASKS.has(task)) return text("Unknown task.", 400);
      await this.state.enqueue({ repository, installation: record.installation, task, ref: request.ref || record.defaultBranch, sha: "", pullRequest: undefined, sender: "", due: now });
      return text(`Queued ${task} for ${repository}; it starts within 5 minutes.`, 200);
    }
    return text("Unknown action.", 400);
  }
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), { headers: { "Content-Type": "application/json" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/") return text("Claude Autofix hub", 200);
    if (request.method !== "POST") return text("Not found.", 404);

    const body = await request.text();
    const hub = new Hub(env);
    const now = Date.now();
    if (pathname === "/webhook") {
      if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get(GITHUB_SIGNATURE_HEADER)))) return text("Bad signature.", 401);
      const effects = effectsOf(request.headers.get("X-GitHub-Event") ?? "", JSON.parse(body) as WebhookPayload, { appSlug: env.APP_SLUG, ignored: new Hub(env).ignored, now });
      for (const effect of effects) await hub.apply(effect, now);
      return text(`Handled ${effects.length} effect(s).`, 200);
    }
    const signature = request.headers.get(REPORT_SIGNATURE_HEADER);
    if (pathname === "/report") {
      if (!(await verifySignature(env.HUB_SECRET, body, signature))) return text("Bad signature.", 401);
      return hub.report(JSON.parse(body) as HubReport, now);
    }
    if (pathname === "/admin") {
      if (!(await verifySignature(env.ADMIN_SECRET, body, signature))) return text("Bad signature.", 401);
      return hub.admin(JSON.parse(body) as AdminRequest, now);
    }
    return text("Not found.", 404);
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    for (const line of await new Hub(env).tick(event.scheduledTime)) console.log(line);
  },
};
