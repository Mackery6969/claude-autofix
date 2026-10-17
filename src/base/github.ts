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
  changes?: number;
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
  user?: { login: string; type?: string } | null;
  author_association?: string;
  created_at?: string;
}

export interface Thread {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  created_at: string;
  user: { login: string; type?: string } | null;
  author_association?: string;
  pull_request?: unknown;
}

export interface ReviewComment extends Comment {
  path: string;
  line: number | null;
  original_line: number | null;
  diff_hunk: string;
  in_reply_to_id?: number;
}

export interface Review {
  id: number;
  body: string | null;
  state: string;
  user: { login: string; type?: string } | null;
  author_association?: string;
  submitted_at?: string;
}

export interface FailedJob {
  id: number;
  name: string;
  workflow: string;
  url: string;
  completedAt: string;
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

  thread(number: number): Promise<Thread> {
    return this.request("GET", `/repos/${this.repository}/issues/${number}`);
  }

  reviewComments(number: number): Promise<ReviewComment[]> {
    return this.paginate<ReviewComment>((page) => `/repos/${this.repository}/pulls/${number}/comments?per_page=100&page=${page}`, 10);
  }

  reviews(number: number): Promise<Review[]> {
    return this.paginate<Review>((page) => `/repos/${this.repository}/pulls/${number}/reviews?per_page=100&page=${page}`, 5);
  }

  async commentOnCommit(sha: string, body: string): Promise<void> {
    await this.request("POST", `/repos/${this.repository}/commits/${encodeURIComponent(sha)}/comments`, { body });
  }

  async createComment(number: number, body: string): Promise<void> {
    await this.request("POST", `/repos/${this.repository}/issues/${number}/comments`, { body });
  }

  async replyToReviewComment(number: number, commentId: number, body: string): Promise<void> {
    await this.request("POST", `/repos/${this.repository}/pulls/${number}/comments/${commentId}/replies`, { body });
  }

  async failedJobs(sha: string): Promise<FailedJob[]> {
    const runs = await this.request<{ workflow_runs: Array<{ id: number; name: string; conclusion: string | null }> }>("GET", `/repos/${this.repository}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=50`);
    const failed: FailedJob[] = [];
    for (const run of runs.workflow_runs.filter((candidate) => candidate.conclusion === "failure")) {
      const jobs = await this.request<{ jobs: Array<{ id: number; name: string; conclusion: string | null; html_url: string; completed_at: string | null }> }>("GET", `/repos/${this.repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
      for (const job of jobs.jobs.filter((candidate) => candidate.conclusion === "failure")) failed.push({ id: job.id, name: job.name, workflow: run.name, url: job.html_url, completedAt: job.completed_at ?? "" });
    }
    return failed;
  }

  async jobLog(jobId: number): Promise<string> {
    const response = await fetch(`${this.#apiUrl}/repos/${this.repository}/actions/jobs/${jobId}/logs`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.#token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "claude-autofix" },
    });
    if (!response.ok) throw new GitHubError(`GET job ${jobId} logs failed (HTTP ${response.status})`, response.status);
    return response.text();
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

  pullRequest(number: number): Promise<PullRequest & { draft?: boolean; user: { login: string; type: string }; base: { ref: string } }> {
    return this.request("GET", `/repos/${this.repository}/pulls/${number}`);
  }

  async codeScanningAlert(number: number): Promise<CodeScanningAlert | undefined> {
    try {
      return await this.request<CodeScanningAlert>("GET", `/repos/${this.repository}/code-scanning/alerts/${number}`);
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) return undefined;
      throw error;
    }
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

  async upsertComment(number: number, marker: string, body: string): Promise<void> {
    const existing = await this.findComment(number, marker);
    const text = body.includes(marker) ? body : `${body}\n\n${marker}`;
    if (existing) await this.request("PATCH", `/repos/${this.repository}/issues/comments/${existing.id}`, { body: text });
    else await this.request("POST", `/repos/${this.repository}/issues/${number}/comments`, { body: text });
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
}

function errorMessage(body: string): string {
  try {
    return (JSON.parse(body) as { message?: string }).message ?? body;
  } catch {
    return body;
  }
}

export function gitHubFor(token: string, repository: string): GitHub {
  return new GitHub({ token, apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com", repository });
}

function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}
