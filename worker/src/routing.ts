export type Task = "security" | "quality";

export interface Job {
  repository: string;
  installation: number;
  task: Task;
  ref: string;
  sha: string;
  pullRequest: number | undefined;
  sender: string;
  due: number;
}

export type Effect =
  | { kind: "enqueue"; job: Job }
  | { kind: "delete-branch"; repository: string; installation: number; branch: string; sha: string }
  | { kind: "register"; installation: number; repositories: Array<{ repository: string; defaultBranch: string | undefined }> }
  | { kind: "unregister"; repositories: string[] };

interface Actor {
  login: string;
  type?: string;
}

export interface WebhookPayload {
  action?: string;
  installation?: { id: number };
  sender?: Actor;
  repository?: { full_name: string; default_branch: string; archived?: boolean };
  repositories?: Array<{ full_name: string }>;
  repositories_added?: Array<{ full_name: string }>;
  repositories_removed?: Array<{ full_name: string }>;
  pull_request?: { number: number; draft?: boolean; user: Actor; head: { ref: string; sha: string; repo: { full_name: string } | null } };
  ref?: string;
  commit_oid?: string;
}

export interface RoutingContext {
  appSlug: string;
  ignored: string[];
  now: number;
}

export const ALERT_SETTLE_MS = 3 * 60_000;
export const ISSUE_SETTLE_MS = 2 * 60_000;
export const DEPENDABOT_GRACE_MS = 65 * 60_000;

const ALERT_ACTIONS = new Set(["created", "reopened", "appeared_in_branch"]);
const ISSUE_ACTIONS = new Set(["opened", "labeled", "reopened"]);
const DEPENDABOT_ACTIONS = new Set(["created", "reopened", "auto_reopened"]);
const QUALITY_PULL_ACTIONS = new Set(["opened", "reopened", "ready_for_review"]);
const SECURITY_PULL_ACTIONS = new Set(["reopened", "ready_for_review"]);

export function jobKey(job: Pick<Job, "repository" | "task" | "ref" | "pullRequest">): string {
  return `job:${job.repository}|${job.task}|${job.pullRequest ? `pr-${job.pullRequest}` : job.ref}`;
}

export function isClaudeBranch(branch: string): boolean {
  return branch.startsWith("claude/");
}

export function effectsOf(event: string, payload: WebhookPayload, context: RoutingContext): Effect[] {
  const installation = payload.installation?.id;
  if (!installation) return [];

  if (event === "installation") {
    if (payload.action === "created") return [register(installation, payload.repositories ?? [], context)];
    if (payload.action === "deleted") return [{ kind: "unregister", repositories: (payload.repositories ?? []).map((repository) => repository.full_name) }];
    return [];
  }
  if (event === "installation_repositories") {
    const effects: Effect[] = [];
    if (payload.repositories_added?.length) effects.push(register(installation, payload.repositories_added, context));
    if (payload.repositories_removed?.length) effects.push({ kind: "unregister", repositories: payload.repositories_removed.map((repository) => repository.full_name) });
    return effects;
  }

  const repository = payload.repository;
  if (!repository || isIgnored(repository.full_name, context.ignored) || repository.archived) return [];
  const known: Effect = { kind: "register", installation, repositories: [{ repository: repository.full_name, defaultBranch: repository.default_branch }] };
  const bySelf = payload.sender?.login.toLowerCase() === `${context.appSlug}[bot]`.toLowerCase();
  const job = (task: Task, ref: string, settle: number, extra: Partial<Job> = {}): Effect => ({
    kind: "enqueue",
    job: { repository: repository.full_name, installation, task, ref, sha: "", pullRequest: undefined, sender: "", due: context.now + settle, ...extra },
  });

  if (event === "pull_request" && payload.pull_request) {
    const pull = payload.pull_request;
    const ownRepository = pull.head.repo?.full_name === repository.full_name;
    if (payload.action === "closed") {
      return ownRepository && isClaudeBranch(pull.head.ref) ? [known, { kind: "delete-branch", repository: repository.full_name, installation, branch: pull.head.ref, sha: pull.head.sha }] : [known];
    }
    if (bySelf || !QUALITY_PULL_ACTIONS.has(payload.action ?? "") || pull.draft || !ownRepository || isClaudeBranch(pull.head.ref) || pull.user.type === "Bot") return [known];
    const changes = { sha: pull.head.sha, pullRequest: pull.number, sender: pull.user.login };
    const security = SECURITY_PULL_ACTIONS.has(payload.action ?? "") ? [job("security", pull.head.ref, ALERT_SETTLE_MS, changes)] : [];
    return [known, job("quality", pull.head.ref, 0, changes), ...security];
  }
  if (bySelf) return [known];

  if (event === "code_scanning_alert" && ALERT_ACTIONS.has(payload.action ?? "") && payload.ref) {
    const pullRequest = /^refs\/pull\/(\d+)\//.exec(payload.ref);
    if (pullRequest) return [known, job("security", "", ALERT_SETTLE_MS, { pullRequest: Number(pullRequest[1]) })];
    const branch = payload.ref.replace(/^refs\/heads\//, "");
    if (branch === payload.ref || isClaudeBranch(branch)) return [known];
    return [known, job("security", branch, ALERT_SETTLE_MS, branch === repository.default_branch ? {} : { sha: payload.commit_oid ?? "" })];
  }
  if (event === "issues" && ISSUE_ACTIONS.has(payload.action ?? "") && payload.sender?.type !== "Bot") {
    return [known, job("security", repository.default_branch, ISSUE_SETTLE_MS)];
  }
  if (event === "dependabot_alert" && DEPENDABOT_ACTIONS.has(payload.action ?? "")) {
    return [known, job("security", repository.default_branch, DEPENDABOT_GRACE_MS)];
  }
  return [known];
}

function register(installation: number, repositories: Array<{ full_name: string }>, context: RoutingContext): Effect {
  return {
    kind: "register",
    installation,
    repositories: repositories.filter((repository) => !isIgnored(repository.full_name, context.ignored)).map((repository) => ({ repository: repository.full_name, defaultBranch: undefined })),
  };
}

export function isIgnored(repository: string, ignored: string[]): boolean {
  return ignored.some((name) => name.toLowerCase() === repository.toLowerCase());
}

export function mergeJobs(existing: Job | undefined, incoming: Job): Job {
  if (!existing) return incoming;
  return { ...incoming, sha: incoming.sha || existing.sha, sender: incoming.sender || existing.sender, due: Math.min(existing.due, incoming.due) };
}
