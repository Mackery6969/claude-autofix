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
- `src/tasks/` holds the tasks that extend it (`security`, `quality`) and the `resume` poller.
- `dist/` is never committed on branches; the release workflow builds it into each tag.

## Checks
Run `npm run check` (typecheck, tests, build) before committing.

The repository runs itself: `.github/workflows/security.yml` builds `dist/` and uses `./` to scan this code with Semgrep on every push and pull request, and `claude-resume.yml` resumes its own paused runs. If the action breaks, its own scan fails first.
