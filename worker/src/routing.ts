export type Task = "security" | "fix" | "scan" | "quality" | "conversation";

export interface Job {
  repository: string;
  installation: number;
  task: Task;
  ref: string;
  sha: string;
  pullRequest: number | undefined;
  issue?: number | undefined;
  before?: string;
  mentioned?: boolean;
  sender: string;
  due: number;
}

export type Effect =
  | { kind: "enqueue"; job: Job }
  | { kind: "delete-branch"; repository: string; installation: number; branch: string; sha: string }
  | { kind: "register"; installation: number; repositories: Array<{ repository: string; defaultBranch: string | undefined }> }
  | { kind: "unregister"; repositories: string[] }
  | { kind: "push"; repository: string; installation: number; defaultBranch: string; branch: string; before: string; after: string; paths: string[]; sender: string };

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
  pull_request?: { number: number; draft?: boolean; state?: string; body?: string | null; user: Actor; head: { ref: string; sha: string; repo: { full_name: string } | null } };
  ref?: string;
  commit_oid?: string;
  issue?: { number: number; body?: string | null; pull_request?: unknown; labels?: Array<{ name: string } | string> };
  alert?: { rule?: { security_severity_level?: string | null } };
  after?: string;
  before?: string;
  deleted?: boolean;
  commits?: Array<{ added?: string[]; modified?: string[]; removed?: string[] }>;
  comment?: { user: Actor; body?: string };
  review?: { user: Actor; body?: string | null; state?: string };
  workflow_run?: { conclusion: string | null; head_branch: string | null; head_sha: string; pull_requests?: Array<{ number: number }>; head_repository?: { full_name: string } | null };
}

export interface RoutingContext {
  appSlug: string;
  ignored: string[];
  now: number;
}

export const ALERT_SETTLE_MS = 3 * 60_000;
export const ISSUE_SETTLE_MS = 2 * 60_000;
export const DEPENDABOT_GRACE_MS = 65 * 60_000;
export const CONVERSATION_SETTLE_MS = 90_000;
export const CHECKS_SETTLE_MS = 3 * 60_000;

const ALERT_ACTIONS = new Set(["created", "reopened", "appeared_in_branch"]);
const SECURITY_ISSUE_LABELS = new Set(["security", "critical"]);
const ISSUE_ACTIONS = new Set(["opened", "labeled", "reopened"]);
const DEPENDABOT_ACTIONS = new Set(["created", "reopened", "auto_reopened"]);
const QUALITY_PULL_ACTIONS = new Set(["opened", "reopened"]);

export function jobKey(job: Pick<Job, "repository" | "task" | "ref" | "pullRequest" | "issue">): string {
  return `job:${job.repository}|${job.task}|${job.pullRequest ? `pr-${job.pullRequest}` : job.issue ? `issue-${job.issue}` : job.ref}`;
}

export function mentions(body: string | null | undefined, handle: string): boolean {
  return new RegExp(`(^|[^\\w-])@${handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(body ?? "");
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

  if (event === "workflow_run" && payload.action === "completed" && payload.workflow_run?.conclusion === "failure") {
    const run = payload.workflow_run;
    if (!isClaudeBranch(run.head_branch ?? "") || (run.head_repository && run.head_repository.full_name !== repository.full_name)) return [known];
    return [known, ...(run.pull_requests ?? []).map((pull) => job("conversation", run.head_branch ?? "", CHECKS_SETTLE_MS, { sha: run.head_sha, pullRequest: pull.number }))];
  }

  if (event === "pull_request" && payload.pull_request) {
    const pull = payload.pull_request;
    const ownRepository = pull.head.repo?.full_name === repository.full_name;
    if (payload.action === "closed") {
      return ownRepository && isClaudeBranch(pull.head.ref) ? [known, { kind: "delete-branch", repository: repository.full_name, installation, branch: pull.head.ref, sha: pull.head.sha }] : [known];
    }
    const summoned = !bySelf && (payload.action === "opened" || payload.action === "edited") && mentions(pull.body, context.appSlug) ? [job("conversation", "", CONVERSATION_SETTLE_MS, { pullRequest: pull.number, mentioned: true, sender: payload.sender?.login ?? "" })] : [];
    if (bySelf || !QUALITY_PULL_ACTIONS.has(payload.action ?? "") || !ownRepository || isClaudeBranch(pull.head.ref) || pull.user.type === "Bot") return [known, ...summoned];
    const changes = { sha: pull.head.sha, pullRequest: pull.number, sender: pull.user.login };
    const security = payload.action === "reopened" ? [job("security", pull.head.ref, ALERT_SETTLE_MS, changes)] : [];
    return [known, job("quality", pull.head.ref, 0, changes), ...security, ...summoned];
  }
  if (bySelf) return [known];

  if (event === "issue_comment" && payload.action === "created" && payload.issue && payload.comment && payload.comment.user.type !== "Bot") {
    const thread = payload.issue.pull_request ? { pullRequest: payload.issue.number } : { issue: payload.issue.number };
    return [known, job("conversation", "", CONVERSATION_SETTLE_MS, { ...thread, mentioned: mentions(payload.comment.body, context.appSlug), sender: payload.comment.user.login })];
  }
  if ((event === "pull_request_review" && payload.action === "submitted") || (event === "pull_request_review_comment" && payload.action === "created")) {
    const pull = payload.pull_request;
    const actor = payload.review?.user ?? payload.comment?.user;
    if (!pull || !actor || actor.type === "Bot") return [known];
    if (event === "pull_request_review" && !payload.review?.body?.trim() && payload.review?.state !== "changes_requested") return [known];
    const mentioned = mentions(payload.review?.body ?? payload.comment?.body, context.appSlug);
    const claudes = isClaudeBranch(pull.head.ref) && pull.head.repo?.full_name === repository.full_name;
    return [known, job("conversation", claudes ? pull.head.ref : "", CONVERSATION_SETTLE_MS, { sha: claudes ? pull.head.sha : "", pullRequest: pull.number, mentioned, sender: actor.login })];
  }

  if (event === "code_scanning_alert" && ALERT_ACTIONS.has(payload.action ?? "") && payload.ref) {
    const task = payload.alert?.rule?.security_severity_level ? "security" : "fix";
    const pullRequest = /^refs\/pull\/(\d+)\//.exec(payload.ref);
    if (pullRequest) return [known, job(task, "", ALERT_SETTLE_MS, { pullRequest: Number(pullRequest[1]) })];
    const branch = payload.ref.replace(/^refs\/heads\//, "");
    if (branch === payload.ref || isClaudeBranch(branch)) return [known];
    return [known, job(task, branch, ALERT_SETTLE_MS, branch === repository.default_branch ? {} : { sha: payload.commit_oid ?? "" })];
  }
  if (event === "issues" && (payload.action === "opened" || payload.action === "edited") && payload.issue && payload.sender?.type !== "Bot" && mentions(payload.issue.body, context.appSlug)) {
    const sweep = payload.action === "opened" ? [job(issueTask(payload), repository.default_branch, ISSUE_SETTLE_MS)] : [];
    return [known, ...sweep, job("conversation", "", CONVERSATION_SETTLE_MS, { issue: payload.issue.number, mentioned: true, sender: payload.sender?.login ?? "" })];
  }
  if (event === "issues" && ISSUE_ACTIONS.has(payload.action ?? "") && payload.sender?.type !== "Bot") {
    return [known, job(issueTask(payload), repository.default_branch, ISSUE_SETTLE_MS)];
  }
  if (event === "push" && payload.ref?.startsWith("refs/heads/") && !payload.deleted && payload.after && !/^0+$/.test(payload.after)) {
    const branch = payload.ref.slice("refs/heads/".length);
    if (isClaudeBranch(branch)) return [known];
    const paths = [...new Set((payload.commits ?? []).flatMap((commit) => [...(commit.added ?? []), ...(commit.modified ?? [])]))];
    return [known, { kind: "push", repository: repository.full_name, installation, defaultBranch: repository.default_branch, branch, before: payload.before ?? "", after: payload.after, paths, sender: payload.sender?.login ?? "" }];
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

function issueTask(payload: WebhookPayload): Task {
  const labels = (payload.issue?.labels ?? []).map((label) => (typeof label === "string" ? label : label.name).toLowerCase());
  return labels.some((label) => SECURITY_ISSUE_LABELS.has(label)) ? "security" : "fix";
}

export function isIgnored(repository: string, ignored: string[]): boolean {
  return ignored.some((name) => name.toLowerCase() === repository.toLowerCase());
}

export function mergeJobs(existing: Job | undefined, incoming: Job): Job {
  if (!existing) return incoming;
  const { mentioned: _, ...rest } = incoming;
  const merged: Job = { ...rest, sha: incoming.sha || existing.sha, sender: incoming.sender || existing.sender, due: Math.min(existing.due, incoming.due) };
  if (existing.before || incoming.before) merged.before = existing.before || incoming.before;
  return incoming.mentioned || existing.mentioned ? { ...merged, mentioned: true } : merged;
}
