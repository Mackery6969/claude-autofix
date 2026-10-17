import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { log, setOutput, warn } from "../base/actions.ts";
import { reportToHub } from "../base/hub.ts";
import { normalizePath, type PathRules } from "../base/paths.ts";
import { changeSetName, filesChanged, type ChangeSet, type PullRequestMode } from "../base/pulls.ts";
import { ClaudeTask, commitMessage, type ClaudeReport, type Delivery, type Helpers, type PullRequestText, type TaskSettings } from "../base/task.ts";
import { isSourcePath, listSourceFiles, nextBatch, readSourceFile, takeUpTo, type SourceFile, type SourceScope } from "./sources.ts";

const DIFF_FILE = ".claude-pr-changes.diff";

export interface QualityOptions {
  areas: string[];
  area: string;
  exclude: string[];
  extensions: string[];
  instructions: string;
  batchLines: number;
  pullRequestMode: PullRequestMode;
  pullRequestAuthors: string[];
}

type QualityPlan =
  | { mode: "batch"; files: SourceFile[]; cursor: string; saveCursor: boolean; wrapped: boolean }
  | { mode: "changes"; files: SourceFile[]; skipped: SourceFile[]; changes: ChangeSet };

export class QualityTask extends ClaudeTask<QualityPlan> {
  protected readonly name = "quality";
  readonly #options: QualityOptions;

  constructor(settings: TaskSettings, options: QualityOptions) {
    super(settings);
    this.#options = options;
  }

  protected async plan(): Promise<QualityPlan | undefined> {
    if (this.settings.changes) return this.planChanges(this.settings.changes);
    if (!(await this.onDefaultBranch())) {
      log("Code-quality passes run on the default branch, on branches and on pull requests.");
      return undefined;
    }
    if (!this.settings.force) {
      const [open] = await this.ownPullRequests("open");
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
    const cursor = area ? "" : (this.settings.hub?.cursor ?? "");
    const batch = nextBatch(files, cursor, this.#options.batchLines);
    setOutput("files", batch.files.length);
    log(`This pass covers ${batch.files.length} of ${files.length} source files${batch.wrapped ? ", starting over from the top" : ""}.`);
    return { mode: "batch", files: batch.files, cursor: batch.cursor, saveCursor: !area, wrapped: batch.wrapped };
  }

  private async planChanges(changes: ChangeSet): Promise<QualityPlan | undefined> {
    const skip = (reason: string) => {
      log(`Not refactoring ${changeSetName(changes)}: ${reason}.`);
      return undefined;
    };
    const skipped = this.whyChangesSkipped(changes, this.#options.pullRequestAuthors);
    if (skipped) return skip(skipped);

    const scope = this.scope([]);
    const changed = (await filesChanged(this.settings.github, changes)).filter((file) => file.status !== "removed" && isSourcePath(file.filename, scope));
    const sources = changed.map((file) => readSourceFile(this.settings.workspace, file.filename)).filter((file): file is SourceFile => file !== undefined && file.lines > 0);
    if (sources.length === 0) return skip(`it doesn't change any source files compared with ${changes.base}`);

    const { taken, skipped: overLimit } = takeUpTo(sources, this.#options.batchLines);
    const patches = changed.filter((file) => taken.some((source) => source.path === file.filename));
    writeFileSync(join(this.settings.workspace, DIFF_FILE), patches.map((file) => `--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch ?? "(diff too large to show)"}\n`).join("\n"));
    setOutput("files", taken.length);
    return { mode: "changes", files: taken, skipped: overLimit, changes };
  }

  protected prompt(plan: QualityPlan, helpers: Helpers): string {
    const fileList = plan.files.map((file) => `- ${file.path} (${file.lines} lines)`).join("\n");
    const focus =
      plan.mode === "batch"
        ? `This is the repository's scheduled code-quality pass. This run covers these ${plan.files.length} files:\n\n${fileList}`
        : `${this.changesDescription(plan.changes)} changes the files below compared with \`${plan.changes.base}\`. Make a code-quality pass over the code it adds or changes; its diff is in \`${DIFF_FILE}\`. Leave untouched code in these files alone unless the change needs it.\n\n${fileList}`;
    return `${focus}

Read every file listed above. You may read any other file for context, but only change the listed ones.

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
- Where you can't build or run the code (for example it needs Windows, a proprietary toolchain, or a game engine), still make small, mechanical improvements you're confident keep behaviour identical. Skip a file only when nothing in it is worth changing.
- Do not start subagents.
- If nothing is worth changing, change nothing.
${this.#options.instructions ? `\n${this.#options.instructions}\n` : ""}
${this.toolRules(helpers)}

When you are done:
1. Run \`${helpers.verify}\`. It must pass. If one of your changes breaks it and you can't repair it, revert that change.
2. ${this.descriptionInstructions("Use a guard clause in load_env")} After the title: a one-paragraph summary, then one bullet per file saying what changed and why behaviour is unchanged, then a "Noticed, not changed" section if you found anything out of scope. Do not commit; the workflow commits your changes.`;
  }

  protected pathRules(plan: QualityPlan): PathRules {
    return { area: ".", excluded: this.#options.exclude.map(normalizePath), files: plan.files.map((file) => file.path) };
  }

  protected scratchFiles(): string[] {
    return [DIFF_FILE];
  }

  protected async finished(plan: QualityPlan): Promise<void> {
    const { hub } = this.settings;
    if (plan.mode !== "batch" || !plan.saveCursor || !hub) return;
    log(`This pass stopped after ${plan.cursor}.`);
    await reportToHub(hub, { kind: "cursor", cursor: plan.cursor }).catch((error: unknown) => warn(`Couldn't tell the hub where this pass stopped, so the next pass repeats it: ${error instanceof Error ? error.message : String(error)}`));
  }

  protected delivery(plan: QualityPlan): Delivery {
    if (plan.mode === "batch") return { kind: "new-pull-request" };
    return this.changesDelivery(plan.changes, this.#options.pullRequestMode);
  }

  protected pullRequest(plan: QualityPlan, report: ClaudeReport): PullRequestText {
    if (plan.mode === "changes") {
      const skipped = plan.skipped.length ? `\n\nSkipped to stay within batch-lines: ${plan.skipped.map((file) => `\`${file.path}\``).join(", ")}.` : "";
      const title = report.title ?? `Code-quality pass on ${changeSetName(plan.changes).replace(/`/g, "")}`;
      return {
        title,
        commitMessage: commitMessage("refactor", title, report.description),
        body: `${report.description}${skipped}${this.footer(report)}`,
      };
    }
    const folders = [...new Set(plan.files.map((file) => file.path.split("/").slice(0, -1).join("/") || "."))];
    const label = folders.length === 1 ? folders[0] : `${folders[0]} and ${folders.length - 1} more`;
    const title = report.title ?? `Code-quality pass over ${label}`;
    return {
      title,
      commitMessage: commitMessage("refactor", title, report.description),
      body: `${report.description}\n\nFiles in this pass: ${plan.files.map((file) => `\`${file.path}\``).join(", ")}.${this.footer(report)} The next pass continues from \`${plan.cursor}\` once this pull request is merged or closed.`,
    };
  }

  private changesDescription(changes: ChangeSet): string {
    return changes.pullRequest ? `Pull request #${changes.pullRequest}` : `Branch \`${changes.branch}\``;
  }

  private scope(areas: string[]): SourceScope {
    return { areas: areas.map(normalizePath), exclude: this.#options.exclude.map(normalizePath), extensions: this.#options.extensions };
  }
}
