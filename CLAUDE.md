# Working on Claude Autofix

## Conserving Claude usage
- Don't spawn subagents or Workflow fan-outs while working on this repo. They draw from the same Claude subscription and can burn through the usage limit fast. Do the work inline with targeted reads and greps.
- If a subagent is truly unavoidable, use a smaller model (Haiku or Sonnet) and keep it to one.
- The action follows the same rule at runtime: Claude's tool list is limited to file tools and allowlisted Bash, so CI runs can't start subagents either. Keep it that way.

## Code style
- No comments. Make the code explain itself through names and structure; put explanations in the README or pull request descriptions.
- TypeScript runs directly on Node 24 (type stripping), so only erasable syntax: no enums, namespaces or parameter properties.
- No runtime dependencies besides `@anthropic-ai/claude-agent-sdk`. Talk to GitHub with `fetch` (see `src/base/github.ts`).

## Layout
- `src/base/` is the shared base: `ClaudeTask` runs the pipeline (plan, run Claude, pause on usage limits, enforce paths, verify, open the pull request).
- `src/tasks/` holds the tasks that extend it: `security` (which also runs as `fix`, for non-security alerts and issues), `scan` (Claude reviews code itself), `quality`, and `conversation` (replies in pull requests and issues).
- `src/base/settings.ts` parses `.github/claude-autofix.yml`; both the action and the hub use it, so it must stay free of Node-only imports.
- `worker/` is the hub, a Cloudflare Worker: it receives the GitHub App's webhooks, queues and schedules work, and dispatches it to each repository's own workflow for that task (`.github/workflows/claude-<task>.yml`), short files the hub commits there (`worker/src/workflow.ts`). Each calls `.github/workflows/run.yml` at `@v3`, which gets credentials from the hub through GitHub's OIDC and runs the action. Repositories without them fall back to the runner repository (`examples/runner.yml`). The action only runs these ways.
- `dist/` is never committed on branches; the release workflow builds it into each tag.

## Checks
Run `npm run check` (typecheck, tests, build) before committing.

The hub works on this repository like any other, using the released action and `.github/claude-autofix.yml`. Pushing changes to `worker/`, the runner workflow or the deploy scripts redeploys the hub (`.github/workflows/hub.yml`), so run `npm run check` before pushing them.
