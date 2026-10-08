import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { log, notice, setOutput } from "../base/actions.ts";
import { checkoutBranchAt, lastCommitIsFromBot } from "../base/git.ts";
import { normalizePath, type PathRules } from "../base/paths.ts";
import { ClaudeTask, DESCRIPTION_FILE, type ClaudeReport, type Delivery, type Helpers, type PullRequestText, type TaskSettings } from "../base/task.ts";
import { isSourcePath, listSourceFiles, nextBatch, readSourceFile, takeUpTo, type SourceFile, type SourceScope } from "./sources.ts";

export const CURSOR_TITLE = "code-quality-cursor";
const DIFF_FILE = ".claude-pr-changes.diff";
const RUNS_CHECKED_FOR_CURSOR = 10;

export type PullRequestMode = "commit" | "pull-request";

export interface PullRequestEvent {
  number: number;
  draft?: boolean;
  user: { login: string; type: string };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
}

export interface QualityOptions {
  areas: string[];
  area: string;
  exclude: string[];
  extensions: string[];
  instructions: string;
  batchLines: number;
  pullRequestMode: PullRequestMode;
  pullRequestAuthors: string[];
  pullRequest: PullRequestEvent | undefined;
}

type QualityPlan =
  | { mode: "batch"; files: SourceFile[]; cursor: string; saveCursor: boolean; wrapped: boolean }
  | { mode: "pull-request"; files: SourceFile[]; skipped: SourceFile[]; pull: PullRequestEvent };

export function cursorMessage(path: string): string {
  return `after=${path}`;
}

export function parseCursor(message: string): string {
  return message.startsWith("after=") ? message.slice("after=".length).trim() : "";
}

export class QualityTask extends ClaudeTask<QualityPlan> {
  protected readonly name = "quality";
  readonly #options: QualityOptions;

  constructor(settings: TaskSettings, options: QualityOptions) {
    super(settings);
    this.#options = options;
  }

  protected async plan(): Promise<QualityPlan | undefined> {
    if (this.settings.eventName.startsWith("pull_request")) return this.planPullRequest();
    if (!(await this.onDefaultBranch())) {
      log("Code-quality passes run on the default branch or on pull requests.");
      return undefined;
    }
    if (!this.settings.force) {
      const [open] = await this.settings.github.pullRequests(this.settings.branch, "open", 1);
      if (open) {
        log(`The last code-quality pull request is still open (${open.html_url}). Merge or close it first, or run with force.`);
        return undefined;
      }
    }

    const area = this.#options.area ? normalizePath(this.#options.area) : "";
    const files = listSourceFiles(this.settings.workspace, this.scope(area ? [area] : this.#options.areas));
    if (files.length === 0) {
      log("No source files to look at. Check areas, exclude and extensions.");
      return undefined;
    }
    const cursor = area ? "" : await this.lastCursor();
    const batch = nextBatch(files, cursor, this.#options.batchLines);
    setOutput("files", batch.files.length);
    log(`This pass covers ${batch.files.length} of ${files.length} source files${batch.wrapped ? ", starting over from the top" : ""}.`);
    return { mode: "batch", files: batch.files, cursor: batch.cursor, saveCursor: !area, wrapped: batch.wrapped };
  }

  private async planPullRequest(): Promise<QualityPlan | undefined> {
    const pull = this.#options.pullRequest;
    if (!pull) return undefined;
    const authors = this.#options.pullRequestAuthors.length ? this.#options.pullRequestAuthors : [this.settings.github.owner];
    const skip = (reason: string) => {
      log(`Not refactoring #${pull.number}: ${reason}.`);
      return undefined;
    };
    if (pull.head.repo?.full_name !== this.settings.github.repository) return skip("it comes from a fork");
    if (pull.draft) return skip("it's a draft");
    if (pull.user.type === "Bot" || pull.head.ref.startsWith("claude/")) return skip("it was opened by a bot");
    if (!authors.some((author) => author.toLowerCase() === pull.user.login.toLowerCase())) return skip(`only pull requests by ${authors.join(", ")} are refactored (pull-request-authors)`);

    checkoutBranchAt({ ...this.pushOptions, branch: pull.head.ref, sha: pull.head.sha });
    if (lastCommitIsFromBot(this.settings.workspace)) return skip("its latest commit is already Claude's");

    const scope = this.scope([]);
    const changed = (await this.settings.github.pullRequestFiles(pull.number)).filter((file) => file.status !== "removed" && isSourcePath(file.filename, scope));
    const sources = changed.map((file) => readSourceFile(this.settings.workspace, file.filename)).filter((file): file is SourceFile => file !== undefined && file.lines > 0);
    if (sources.length === 0) return skip("it doesn't change any source files");

    const { taken, skipped } = takeUpTo(sources, this.#options.batchLines);
    const patches = changed.filter((file) => taken.some((source) => source.path === file.filename));
    writeFileSync(join(this.settings.workspace, DIFF_FILE), patches.map((file) => `--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch ?? "(diff too large to show)"}\n`).join("\n"));
    setOutput("files", taken.length);
    return { mode: "pull-request", files: taken, skipped, pull };
  }

  protected prompt(plan: QualityPlan, helpers: Helpers): string {
    const fileList = plan.files.map((file) => `- ${file.path} (${file.lines} lines)`).join("\n");
    const focus =
      plan.mode === "batch"
        ? `This is the repository's scheduled code-quality pass. This run covers these ${plan.files.length} files:\n\n${fileList}`
        : `Pull request #${plan.pull.number} changes the files below. Make a code-quality pass over the code this pull request adds or changes; its diff is in \`${DIFF_FILE}\`. Leave untouched code in these files alone unless the change needs it.\n\n${fileList}`;
    const workflowRule = this.canEditWorkflows ? "" : "\n- Do not edit files under .github/workflows/: this run cannot push workflow changes.";
    return `${focus}

You may read any file in the repository for context, but only change the files listed above.

Follow the code quality and refactoring policy in CLAUDE.md if the repository has one. Where it says nothing, use these defaults:

- Keep strict backward compatibility for every public function, class, API, command, config key, and file format.
- Replace deep nesting with early returns and guard clauses.
- Extract duplicated logic into small, private, single-purpose helpers.
- Modernize outdated idioms where it genuinely reads better.

Rules for this run:

- Behaviour must not change. This is a refactor, not a feature or bug-fix pass.
- Make no security fixes, even for problems you spot. List them under "Noticed, not changed" instead; security fixes go through a separate pipeline and are never mixed with quality changes.
- Pick the highest-value improvements and keep the change easy to review.
- Match each file's existing style and naming.
- Where you can't build or run the code (for example it needs Windows, a proprietary toolchain, or a game engine), keep changes especially small and mechanical.
- Do not start subagents.${workflowRule}
- If nothing is worth changing, change nothing.
${this.#options.instructions ? `\n${this.#options.instructions}\n` : ""}
When you are done:
1. Run \`${helpers.verify}\`. It must pass. If one of your changes breaks it and you can't repair it, revert that change.
2. Write a description of your changes to \`${DESCRIPTION_FILE}\` in the repository root: a one-paragraph summary, then one bullet per file saying what changed and why behaviour is unchanged, then a "Noticed, not changed" section if you found anything out of scope. Do not commit; the workflow commits your changes.`;
  }

  protected pathRules(plan: QualityPlan): PathRules {
    return { area: ".", excluded: this.#options.exclude.map(normalizePath), files: plan.files.map((file) => file.path) };
  }

  protected scratchFiles(): string[] {
    return [DIFF_FILE];
  }

  protected finished(plan: QualityPlan): void {
    if (plan.mode === "batch" && plan.saveCursor) notice(cursorMessage(plan.cursor), CURSOR_TITLE);
  }

  protected delivery(plan: QualityPlan): Delivery {
    if (plan.mode === "batch") return { kind: "pull-request", branch: this.settings.branch };
    if (this.#options.pullRequestMode === "commit") return { kind: "push", branch: plan.pull.head.ref, pullRequest: plan.pull.number };
    return { kind: "pull-request", branch: `${this.settings.branch}-pr-${plan.pull.number}`, base: plan.pull.head.ref };
  }

  protected pullRequest(plan: QualityPlan, report: ClaudeReport): PullRequestText {
    if (plan.mode === "pull-request") {
      const skipped = plan.skipped.length ? `\n\nSkipped to stay within batch-lines: ${plan.skipped.map((file) => `\`${file.path}\``).join(", ")}.` : "";
      return {
        title: this.#options.pullRequestMode === "commit" ? "Claude code-quality pass" : `Code quality for #${plan.pull.number}`,
        commitMessage: `refactor: code-quality pass on #${plan.pull.number}`,
        body: `${report.description}${skipped}${this.footer(report)}`,
      };
    }
    const folders = [...new Set(plan.files.map((file) => file.path.split("/").slice(0, -1).join("/") || "."))];
    const label = folders.length === 1 ? folders[0] : `${folders[0]} and ${folders.length - 1} more`;
    return {
      title: `Code quality: ${label}`,
      commitMessage: `refactor: code-quality pass over ${label}`,
      body: `${report.description}\n\nFiles in this pass: ${plan.files.map((file) => `\`${file.path}\``).join(", ")}.${this.footer(report)} The next pass continues from \`${plan.cursor}\` once this pull request is merged or closed.`,
    };
  }

  private scope(areas: string[]): SourceScope {
    return { areas: areas.map(normalizePath), exclude: this.#options.exclude.map(normalizePath), extensions: this.#options.extensions };
  }

  private async lastCursor(): Promise<string> {
    const { github, runId } = this.settings;
    const own = await github.workflowRun(runId);
    const runs = await github.workflowRuns(own.workflow_id, await this.defaultBranch());
    for (const run of runs.filter((candidate) => candidate.id !== own.id && !candidate.event.startsWith("pull_request")).slice(0, RUNS_CHECKED_FOR_CURSOR)) {
      const marker = await github.runAnnotation(run.id, CURSOR_TITLE);
      if (marker) return parseCursor(marker.message);
    }
    return "";
  }
}
