import { ActionFailure } from "./actions.ts";

export class GitHubError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface PullRequest {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  title?: string;
  body: string | null;
  user?: { login: string } | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
}

export interface Branch {
  name: string;
  sha: string;
}

export interface PullRequestFile {
  filename: string;
  status: string;
  patch?: string;
}

export interface CodeScanningAlert {
  number: number;
  html_url: string;
  rule: { id: string; severity: string | null; security_severity_level: string | null; description: string; tags?: string[] };
  tool: { name: string };
  most_recent_instance: { location: { path: string; start_line: number; end_line: number }; message: { text: string } };
}

export interface DependabotAlert {
  number: number;
  html_url: string;
  created_at: string;
  dependency: { package: { ecosystem: string; name: string }; manifest_path: string; scope: string | null; relationship?: string | null };
  security_advisory: { ghsa_id: string; cve_id: string | null; summary: string; description: string; severity: string; references?: Array<{ url: string }> };
  security_vulnerability: { vulnerable_version_range: string; first_patched_version: { identifier: string } | null; severity?: string };
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  created_at: string;
  user: { login: string } | null;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
}

export interface Comment {
  id: number;
  body: string | null;
}

export interface WorkflowRun {
  id: number;
  workflow_id: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_branch: string | null;
  created_at: string;
  html_url: string;
}

export interface Job {
  id: number;
  name: string;
  check_run_url?: string;
}

export function checkRunId(job: Job): number {
  const fromUrl = Number(job.check_run_url?.split("/").pop());
  return Number.isInteger(fromUrl) && fromUrl > 0 ? fromUrl : job.id;
}

export interface Annotation {
  title: string | null;
  message: string;
  annotation_level: string;
}

export interface GitHubOptions {
  token: string;
  apiUrl: string;
  repository: string;
}

export class GitHub {
  readonly repository: string;
  readonly owner: string;
  readonly #token: string;
  readonly #apiUrl: string;

  constructor(options: GitHubOptions) {
    this.#token = options.token;
    this.#apiUrl = options.apiUrl.replace(/\/$/, "");
    this.repository = options.repository;
    this.owner = options.repository.split("/")[0] ?? "";
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.#apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.#token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "claude-autofix",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GitHubError(`${method} ${path} failed (HTTP ${response.status}): ${errorMessage(text)}`, response.status);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async defaultBranch(): Promise<string> {
    const repo = await this.request<{ default_branch: string }>("GET", `/repos/${this.repository}`);
    return repo.default_branch;
  }

  async pullRequests(branch: string, state: "open" | "all", pages = 3): Promise<PullRequest[]> {
    const head = encodeURIComponent(`${this.owner}:${branch}`);
    return this.paginate<PullRequest>((page) => `/repos/${this.repository}/pulls?head=${head}&state=${state}&per_page=100&page=${page}`, pages);
  }

  async pullRequestsFromBranches(prefix: string, state: "open" | "all", pages = 3): Promise<PullRequest[]> {
    const pulls = await this.paginate<PullRequest>((page) => `/repos/${this.repository}/pulls?state=${state}&sort=created&direction=desc&per_page=100&page=${page}`, pages);
    return pulls.filter((pull) => pull.head.repo?.full_name === this.repository && pull.head.ref.startsWith(prefix));
  }

  pullRequestFiles(number: number): Promise<PullRequestFile[]> {
    return this.paginate<PullRequestFile>((page) => `/repos/${this.repository}/pulls/${number}/files?per_page=100&page=${page}`, 30);
  }

  async compareFiles(base: string, head: string): Promise<PullRequestFile[]> {
    const comparison = await this.request<{ files?: PullRequestFile[] }>("GET", `/repos/${this.repository}/compare/${encodeRef(base)}...${encodeRef(head)}`);
    return comparison.files ?? [];
  }

  comments(number: number): Promise<Comment[]> {
    return this.paginate<Comment>((page) => `/repos/${this.repository}/issues/${number}/comments?per_page=100&page=${page}`, 10);
  }

  async branchesStartingWith(prefix: string): Promise<Branch[]> {
    const refs = await this.request<Array<{ ref: string; object: { sha: string } }>>("GET", `/repos/${this.repository}/git/matching-refs/heads/${encodeRef(prefix)}`);
    return refs.map((ref) => ({ name: ref.ref.replace(/^refs\/heads\//, ""), sha: ref.object.sha }));
  }

  async deleteBranch(name: string): Promise<void> {
    await this.request("DELETE", `/repos/${this.repository}/git/refs/heads/${encodeRef(name)}`);
  }

  async openIssues(): Promise<Issue[]> {
    const issues = await this.paginate<Issue>((page) => `/repos/${this.repository}/issues?state=open&sort=created&direction=asc&per_page=100&page=${page}`, 5);
    return issues.filter((issue) => !issue.pull_request);
  }

  pullRequest(number: number): Promise<PullRequest & { draft?: boolean; merged?: boolean; user: { login: string; type: string }; base: { ref: string } }> {
    return this.request("GET", `/repos/${this.repository}/pulls/${number}`);
  }

  async openAlerts(ref?: string): Promise<CodeScanningAlert[]> {
    const onRef = ref ? `&ref=${encodeURIComponent(ref)}` : "";
    try {
      return await this.paginate<CodeScanningAlert>((page) => `/repos/${this.repository}/code-scanning/alerts?state=open${onRef}&per_page=100&page=${page}`, 10);
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) return [];
      throw error;
    }
  }

  dependabotAlerts(): Promise<DependabotAlert[]> {
    return this.request<DependabotAlert[]>("GET", `/repos/${this.repository}/dependabot/alerts?state=open&sort=created&direction=asc&per_page=100`);
  }

  async dismissDependabotAlert(number: number, reason: string, comment: string): Promise<void> {
    await this.request("PATCH", `/repos/${this.repository}/dependabot/alerts/${number}`, { state: "dismissed", dismissed_reason: reason, dismissed_comment: comment });
  }

  openPullRequests(): Promise<PullRequest[]> {
    return this.paginate<PullRequest>((page) => `/repos/${this.repository}/pulls?state=open&per_page=100&page=${page}`, 3);
  }

  issuesCreatedBy(login: string): Promise<Issue[]> {
    return this.paginate<Issue>((page) => `/repos/${this.repository}/issues?state=all&creator=${encodeURIComponent(login)}&per_page=100&page=${page}`, 3);
  }

  createIssue(issue: { title: string; body: string; labels: string[] }): Promise<Issue> {
    return this.request("POST", `/repos/${this.repository}/issues`, issue);
  }

  async dismissAlert(number: number, reason: string, comment: string): Promise<void> {
    await this.request("PATCH", `/repos/${this.repository}/code-scanning/alerts/${number}`, { state: "dismissed", dismissed_reason: reason, dismissed_comment: comment });
  }

  async botUserId(slug: string): Promise<number> {
    const user = await this.request<{ id: number }>("GET", `/users/${encodeURIComponent(`${slug}[bot]`)}`);
    return user.id;
  }

  async findComment(number: number, marker: string): Promise<Comment | undefined> {
    return (await this.comments(number)).find((comment) => comment.body?.includes(marker));
  }

  async commitSha(repository: string, ref: string): Promise<string> {
    const commit = await this.request<{ sha: string }>("GET", `/repos/${repository}/commits/${encodeURIComponent(ref)}`);
    return commit.sha;
  }

  async suggestChanges(number: number, commitId: string, body: string, suggestions: Array<{ path: string; line: number; note: string; replacement: string }>): Promise<void> {
    if (suggestions.length === 0) return;
    await this.request("POST", `/repos/${this.repository}/pulls/${number}/reviews`, {
      commit_id: commitId,
      event: "COMMENT",
      body,
      comments: suggestions.map((suggestion) => ({
        path: suggestion.path,
        line: suggestion.line,
        side: "RIGHT",
        body: `${suggestion.note}\n\n\`\`\`suggestion\n${suggestion.replacement}\n\`\`\``,
      })),
    });
  }

  async upsertComment(number: number, marker: string, body: string): Promise<void> {
    const existing = await this.findComment(number, marker);
    const text = `${body}\n\n${marker}`;
    if (existing) await this.request("PATCH", `/repos/${this.repository}/issues/comments/${existing.id}`, { body: text });
    else await this.request("POST", `/repos/${this.repository}/issues/${number}/comments`, { body: text });
  }

  async workflowRuns(workflowId: number, branch: string): Promise<WorkflowRun[]> {
    const result = await this.request<{ workflow_runs: WorkflowRun[] }>("GET", `/repos/${this.repository}/actions/workflows/${workflowId}/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=20`);
    return result.workflow_runs;
  }

  async runAnnotation(runId: number, title: string): Promise<Annotation | undefined> {
    for (const job of await this.jobs(runId)) {
      const match = (await this.annotations(job)).find((annotation) => annotation.title === title);
      if (match) return match;
    }
    return undefined;
  }

  private async paginate<T>(path: (page: number) => string, pages: number): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= pages; page++) {
      const batch = await this.request<T[]>("GET", path(page));
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  }

  createPullRequest(pull: { title: string; head: string; base: string; body: string }): Promise<PullRequest> {
    return this.request("POST", `/repos/${this.repository}/pulls`, pull);
  }

  updatePullRequest(number: number, pull: { title: string; body: string }): Promise<PullRequest> {
    return this.request("PATCH", `/repos/${this.repository}/pulls/${number}`, pull);
  }

  async addLabels(number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.request("POST", `/repos/${this.repository}/issues/${number}/labels`, { labels });
  }

  workflowRun(runId: number | string): Promise<WorkflowRun> {
    return this.request("GET", `/repos/${this.repository}/actions/runs/${runId}`);
  }

  async recentRuns(since: Date, pages = 3): Promise<WorkflowRun[]> {
    const created = encodeURIComponent(`>=${since.toISOString().slice(0, 10)}`);
    const runs: WorkflowRun[] = [];
    for (let page = 1; page <= pages; page++) {
      const result = await this.request<{ workflow_runs: WorkflowRun[] }>("GET", `/repos/${this.repository}/actions/runs?created=${created}&per_page=100&page=${page}`);
      runs.push(...result.workflow_runs);
      if (result.workflow_runs.length < 100) break;
    }
    return runs;
  }

  async jobs(runId: number): Promise<Job[]> {
    const result = await this.request<{ jobs: Job[] }>("GET", `/repos/${this.repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
    return result.jobs;
  }

  annotations(job: Job): Promise<Annotation[]> {
    return this.request("GET", `/repos/${this.repository}/check-runs/${checkRunId(job)}/annotations?per_page=100`);
  }

  async cancelRun(runId: number | string): Promise<void> {
    await this.request("POST", `/repos/${this.repository}/actions/runs/${runId}/cancel`);
  }

  async rerun(runId: number): Promise<void> {
    await this.request("POST", `/repos/${this.repository}/actions/runs/${runId}/rerun`);
  }

  async dispatchWorkflow(workflow: number | string, ref: string): Promise<void> {
    await this.request("POST", `/repos/${this.repository}/actions/workflows/${encodeURIComponent(String(workflow))}/dispatches`, { ref });
  }

  async enableWorkflow(workflow: number | string): Promise<void> {
    await this.request("PUT", `/repos/${this.repository}/actions/workflows/${encodeURIComponent(String(workflow))}/enable`);
  }

  async disableWorkflow(workflow: number | string): Promise<void> {
    await this.request("PUT", `/repos/${this.repository}/actions/workflows/${encodeURIComponent(String(workflow))}/disable`);
  }

}

function errorMessage(body: string): string {
  try {
    return (JSON.parse(body) as { message?: string }).message ?? body;
  } catch {
    return body;
  }
}

export function gitHubFromEnvironment(token: string, repository = process.env.GITHUB_REPOSITORY): GitHub {
  if (!repository) throw new ActionFailure("GITHUB_REPOSITORY is not set. This action only runs inside GitHub Actions.");
  return new GitHub({ token, apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com", repository });
}

function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}
