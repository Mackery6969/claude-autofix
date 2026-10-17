import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { log, setOutput, warn } from "../base/actions.ts";
import type { PullRequestFile } from "../base/github.ts";
import { reportToHub } from "../base/hub.ts";
import { normalizePath, type PathRules } from "../base/paths.ts";
import { changeSetName, type ChangeSet, type PullRequestMode } from "../base/pulls.ts";
import { matchesAny } from "../base/settings.ts";
import { ClaudeTask, commitMessage, type ClaudeReport, type Delivery, type Helpers, type PullRequestText, type TaskSettings } from "../base/task.ts";
import { isSourcePath, listSourceFiles, nextBatch, type SourceFile, type SourceScope } from "./sources.ts";

const CHANGES_FILE = ".claude-scan-changes.diff";
const NO_COMMIT = /^0+$/;

export interface ScanOptions {
  paths: string[];
  maxLines: number;
  batches: number;
  exclude: string[];
  extensions: string[];
  before: string;
  sha: string;
  pullRequestMode: PullRequestMode;
  pullRequestAuthors: string[];
}

type ScanPlan =
  | { mode: "batch"; files: SourceFile[]; cursor: string; lapDone: boolean; changed: boolean }
  | { mode: "changes"; files: PullRequestFile[]; skipped: string[]; changes: ChangeSet | undefined; base: string; sha: string; label: string; changed: boolean };

export function lapBatches(files: SourceFile[], cursor: string, maxLines: number, batches: number): Array<{ files: SourceFile[]; cursor: string; lapDone: boolean }> {
  const last = files.at(-1)?.path;
  const planned: Array<{ files: SourceFile[]; cursor: string; lapDone: boolean }> = [];
  let position = cursor;
  for (let index = 0; index < batches; index++) {
    const batch = nextBatch(files, position, maxLines);
    if (batch.files.length === 0 || (index > 0 && batch.wrapped)) break;
    const lapDone = batch.cursor === last;
    planned.push({ files: batch.files, cursor: batch.cursor, lapDone });
    position = batch.cursor;
    if (lapDone) break;
  }
  return planned;
}

export function changedLineCount(file: PullRequestFile): number {
  if (typeof file.changes === "number") return file.changes;
  return (file.patch ?? "").split("\n").filter((line) => /^[+-](?![+-]{2} )/.test(line)).length;
}

export function withinBudget(files: PullRequestFile[], maxLines: number): { taken: PullRequestFile[]; skipped: PullRequestFile[] } {
  const taken: PullRequestFile[] = [];
  const skipped: PullRequestFile[] = [];
  let total = 0;
  for (const file of [...files].sort((a, b) => changedLineCount(b) - changedLineCount(a))) {
    const lines = changedLineCount(file);
    if (taken.length > 0 && total + lines > maxLines) skipped.push(file);
    else {
      taken.push(file);
      total += lines;
    }
  }
  return { taken, skipped };
}

export class ScanTask extends ClaudeTask<ScanPlan> {
  protected readonly name = "scan";
  readonly #options: ScanOptions;

  constructor(settings: TaskSettings, options: ScanOptions) {
    super(settings);
    this.#options = options;
  }

  private get scope(): SourceScope {
    return { areas: [], exclude: this.#options.exclude.map(normalizePath), extensions: this.#options.extensions };
  }

  private inScope(path: string): boolean {
    return isSourcePath(path, this.scope) && matchesAny(path, this.#options.paths);
  }

  protected async plan(): Promise<ScanPlan[] | ScanPlan | undefined> {
    const { changes } = this.settings;
    const pushed = this.#options.before && !NO_COMMIT.test(this.#options.before);
    if (changes || pushed) return this.planChanges(changes);
    if (!(await this.onDefaultBranch())) return undefined;

    const files = listSourceFiles(this.settings.workspace, this.scope).filter((file) => matchesAny(file.path, this.#options.paths));
    if (files.length === 0) {
      log("No source files to scan. Check scan-paths, exclude and extensions.");
      return undefined;
    }
    const batches = lapBatches(files, this.settings.hub?.cursor ?? "", this.#options.maxLines, this.#options.batches);
    const covered = batches.reduce((total, batch) => total + batch.files.length, 0);
    setOutput("files", covered);
    log(`This run scans ${covered} of ${files.length} source files in ${batches.length} batch(es)${batches.at(-1)?.lapDone ? ", finishing the lap" : ""}.`);
    return batches.map((batch) => ({ mode: "batch", files: batch.files, cursor: batch.cursor, lapDone: batch.lapDone, changed: false }));
  }

  private async planChanges(changes: ChangeSet | undefined): Promise<ScanPlan | undefined> {
    const { github } = this.settings;
    const pushed = this.#options.before && !NO_COMMIT.test(this.#options.before) ? this.#options.before : undefined;
    const base = pushed ?? changes?.base ?? "";
    const sha = changes?.sha ?? this.#options.sha;
    const label = pushed ? `the push to \`${changes?.branch ?? this.settings.ref}\`` : changes ? changeSetName(changes) : `\`${this.settings.ref}\``;
    if (!base || !sha) return undefined;
    if (changes) {
      const skipped = this.whyChangesSkipped(changes, this.#options.pullRequestAuthors);
      if (skipped) {
        log(`Not scanning ${label}: ${skipped}.`);
        return undefined;
      }
    }

    const all = (changes?.pullRequest && !pushed ? await github.pullRequestFiles(changes.pullRequest) : await github.compareFiles(base, sha)).filter((file) => file.status !== "removed" && this.inScope(file.filename));
    if (all.length === 0) {
      log(`${label} changes no source files in scope.`);
      return undefined;
    }
    const { taken, skipped } = withinBudget(all, this.#options.maxLines);
    writeFileSync(join(this.settings.workspace, CHANGES_FILE), taken.map((file) => `--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch ?? "(diff too large to show; read the file)"}\n`).join("\n"));
    setOutput("files", taken.length);
    log(`Scanning ${taken.length} changed file(s) in ${label}${skipped.length ? `; ${skipped.length} more are over scan-lines` : ""}.`);
    return { mode: "changes", files: taken, skipped: skipped.map((file) => file.filename), changes, base, sha, label, changed: false };
  }

  protected describe(plan: ScanPlan): string {
    return plan.mode === "batch" ? `${plan.files.length} files` : plan.label;
  }

  protected prompt(plan: ScanPlan, helpers: Helpers): string {
    const focus =
      plan.mode === "batch"
        ? `This is the repository's scheduled scan. Review these files:\n\n${plan.files.map((file) => `- ${file.path} (${file.lines} lines)`).join("\n")}\n\nRead each one. Read other files only to check how something listed here is used.`
        : `Review what ${plan.label.replace(/`/g, "")} changed. The changes are in \`${CHANGES_FILE}\`. Start from the changed lines and the code around them in each file; read further (a function a change calls, where a changed value ends up) only as far as you need to judge whether the change is safe and correct. Don't review untouched code beyond that.${plan.skipped.length ? `\n\nThese changed files are over the scan's size limit and are left out: ${plan.skipped.map((path) => `\`${path}\``).join(", ")}.` : ""}`;
    return `${focus}

Look for security vulnerabilities (injection, missing authorization or validation, unsafe deserialization, path traversal, secrets in code, unsafe use of untrusted input, race conditions) and real bugs (crashes, wrong results, resource leaks). Follow the security policy in CLAUDE.md if the repository has one.

Rules for this run:

- Only report problems you're confident are real, with a concrete way they go wrong. No style, naming or refactoring suggestions; those belong to other passes.
- Fix what you can with the smallest correct change, using the standard mechanism for the language or library. Change only the files listed above.
- Never write a commit SHA, version number, checksum or URL you can't confirm from files in this repository; you have no network access.
- Do not start subagents.
- If you find nothing, change nothing and write nothing.

${this.toolRules(helpers)}

When you are done, if you found anything:
1. If you changed anything, run \`${helpers.verify}\`. It must pass; revert a fix you can't make pass and report the problem instead.
2. ${this.descriptionInstructions("Validate the redirect target in the login handler")} After the title: a one-sentence summary, then a table with one row per problem: file:line, what's wrong and how it goes wrong, and Fixed or Needs a human. Do not commit; the workflow commits your changes.`;
  }

  protected pathRules(plan: ScanPlan): PathRules {
    const files = plan.mode === "batch" ? plan.files.map((file) => file.path) : plan.files.map((file) => file.filename);
    return { area: ".", excluded: this.#options.exclude.map(normalizePath), files };
  }

  protected scratchFiles(): string[] {
    return [CHANGES_FILE];
  }

  protected async finished(plan: ScanPlan): Promise<void> {
    const { hub } = this.settings;
    if (plan.mode !== "batch" || !hub) return;
    await reportToHub(hub, { kind: "cursor", cursor: plan.cursor, lapDone: plan.lapDone }).catch((error: unknown) => warn(`Couldn't tell the hub where this scan stopped, so the next one repeats it: ${error instanceof Error ? error.message : String(error)}`));
  }

  protected delivery(plan: ScanPlan): Delivery {
    if (plan.mode === "changes" && plan.changes) return this.changesDelivery(plan.changes, this.#options.pullRequestMode);
    return { kind: "new-pull-request" };
  }

  protected pullRequest(plan: ScanPlan, report: ClaudeReport): PullRequestText {
    plan.changed = true;
    const title = report.title ?? `Fix problems found scanning ${plan.mode === "batch" ? `${plan.files.length} files` : plan.label.replace(/`/g, "")}`;
    const scanned = plan.mode === "batch" ? plan.files.map((file) => `\`${file.path}\``).join(", ") : plan.files.map((file) => `\`${file.filename}\``).join(", ");
    const skipped = plan.mode === "changes" && plan.skipped.length ? ` Over scan-lines, not scanned: ${plan.skipped.map((path) => `\`${path}\``).join(", ")}.` : "";
    return {
      title,
      commitMessage: commitMessage("fix", title, report.description),
      body: `${report.description}\n\nScanned: ${scanned}.${skipped}${this.footer(report)}`,
    };
  }

  protected async delivered(plan: ScanPlan, _pullUrl: string | undefined, report: ClaudeReport): Promise<void> {
    if (plan.changed || !report.title) return;
    const { github, labels } = this.settings;
    const body = `${report.description}${this.footer(report)}`;
    try {
      if (plan.mode === "changes") {
        await github.commentOnCommit(plan.sha, `### ${report.title}\n\n${body}`);
        log(`Commented on ${plan.sha.slice(0, 12)} with what the scan found.`);
      } else {
        const issue = await github.createIssue({ title: report.title, body, labels });
        log(`Opened ${issue.html_url} for what the scan found.`);
      }
    } catch (error) {
      warn(`Couldn't report what the scan found: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
