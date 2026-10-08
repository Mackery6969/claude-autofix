# Claude Autofix

A GitHub Action that puts Claude to work on your repositories the way Dependabot works on your dependencies: it does the job on a schedule and hands you a pull request to review.

- **Security:** scans with [Semgrep](https://semgrep.dev) on every push, every week and on demand. Claude triages new findings on the default branch: real flaws get fixed with standard library mechanisms, false positives get an explained `nosemgrep` suppression. Findings also go to **Security → Code scanning**.
- **Code quality:** once a week, Claude makes a small, behaviour-preserving refactoring pass over the next batch of files, working through the whole codebase a batch at a time, so even large repositories stay cheap and reviewable. On your own pull requests, it can also tidy the code the pull request changes.
- **Runs on your Claude subscription.** Hitting a usage limit doesn't fail anything: the run marks itself paused, shows as cancelled, and starts again by itself once the limit resets, whether that's the 5-hour window or the weekly one.

Security fixes and refactoring never share a pull request, and nothing is merged for you.

## Quick start

**1. Get a token for your Claude subscription.** On your computer, run:

```bash
claude setup-token
```

**2. Add it to each repository you want this in.** Go to **Settings → Secrets and variables → Actions → New repository secret**, name it `CLAUDE_CODE_OAUTH_TOKEN`, and paste the token. This secret is what turns Claude on: repositories (and forks) without it still get the Semgrep scan, but Claude never runs there, so nobody else can spend your usage. To use API credits instead, add `ANTHROPIC_API_KEY` and pass it as `anthropic-api-key`.

**3. Let Actions open pull requests.** In **Settings → Actions → General**, tick **Allow GitHub Actions to create and approve pull requests**.

**4. Add the workflows.** Copy the three files in [`examples/`](examples) to `.github/workflows/` and set `verify-command` for the repository:

| File | What it does |
| --- | --- |
| [`security.yml`](examples/security.yml) | Scan on push, pull request, weekly and on demand; Claude triages new findings on the default branch. |
| [`code-quality.yml`](examples/code-quality.yml) | A refactoring pass every week, and one when you open a pull request. |
| [`claude-resume.yml`](examples/claude-resume.yml) | Restarts runs that paused on a usage limit. It switches itself off when nothing is paused. |

**5. Optionally, write down your rules.** Claude reads the repository's `CLAUDE.md`. [`examples/CLAUDE.md`](examples/CLAUDE.md) is a starting point for how to handle findings and what a good refactor looks like.

## How it works

### Security

1. Semgrep scans the checkout (`p/default`, `p/secrets` and `p/github-actions` unless you set `semgrep-config`) and uploads the results to code scanning.
2. On pull requests and other branches it stops there. Claude only works on the default branch.
3. Each finding gets a key from its rule, its file and the code it flags, so unrelated edits that move it to another line don't make it "new", but changing the flagged code does.
4. Findings that an earlier pull request from `claude/security-fixes` already covered (open, merged or closed) are skipped. **Closing that pull request is how you say "ignore these"**, like closing a Dependabot update. Run with `force` to triage them again.
5. Up to `max-findings` of the rest, most severe first, go to Claude. It fixes or suppresses each one, re-runs Semgrep, and runs your `verify-command`.
6. The changes are committed as `github-actions[bot]` and opened as a pull request with a table of every finding and what was done about it. While it's open, no new security pull request is started; the next batch follows once you merge or close it.

### Code quality

**Weekly passes** work through the codebase in batches of about `batch-lines` lines (1,500 by default):

1. The action lists the repository's source files (by `extensions`, inside `areas` if you set any, leaving out `exclude`d paths, lockfiles, minified, generated and vendored code) in a fixed order.
2. Each pass takes the next batch after the last file the previous pass covered, and wraps around to the start at the end. Where it stopped is kept on the workflow run itself, so there's nothing to commit or configure.
3. Claude may read any file for context but only change the files in its batch. It makes no security fixes; anything it notices goes in the pull request description.
4. If the last code-quality pull request is still open, the week is skipped, so reviewed work is never overwritten.

A huge repository simply takes more weeks to get through. To go faster, raise `batch-lines` or run the workflow more often.

**On pull requests** (`pull_request` events), Claude looks at the source files the pull request changes, up to `batch-lines`, using the pull request's diff to focus on the new code. With `pull-request-mode: commit` (the default) it pushes a commit to the pull request's branch and leaves one summary comment that it keeps up to date; with `pull-request-mode: pull-request` it opens a separate pull request into your branch instead. It only does this for:

- pull requests from branches in the same repository (never forks),
- opened by someone in `pull-request-authors` (by default, the repository owner), so collaborators' pull requests don't spend your usage,
- that aren't drafts or opened by bots, and whose latest commit isn't already Claude's.

It never force-pushes your branch: if you pushed while Claude was working, it stops and leaves your commits alone. The example runs once when a pull request is opened or marked ready; add `synchronize` to its `types` to run on every push, at the cost of more usage.

### Usage limits

When Claude reports a usage limit, the run:

1. Records when the limit resets in a `claude-paused` notice on the run.
2. Turns on the resume workflow.
3. Cancels itself, so it shows as cancelled rather than failed. Nothing is committed.

Every 30 minutes while something is paused, the resume workflow checks each workflow's latest runs. Once the reset time has passed, it starts a fresh run on the default branch. When nothing is left waiting, it turns itself off, so it costs nothing while idle. If that fresh run hits the limit again (a weekly limit, say), it pauses again with the new reset time.

The action never sleeps in a job waiting for a limit, and Claude can't start subagents, so a run doesn't quietly multiply its usage.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `task` | | `security`, `quality` or `resume`. |
| `claude-code-oauth-token` | | Your subscription token from `claude setup-token`. Without it (or `anthropic-api-key`), Claude is off. |
| `anthropic-api-key` | | Anthropic API key, billed per use. |
| `model` | `claude-opus-5-5` (security), `claude-sonnet-5-5` (quality) | Claude model. |
| `max-budget-usd` | `5` (security), `3` (quality) | Stop Claude once a run has used this much, at API prices. On a subscription it caps how much of your usage one run can take. |
| `verify-command` | | Shell commands that must pass after Claude's changes, such as `npm ci && npm test`. Claude runs it too, and fixes or reverts what breaks it. Keep its build output gitignored. |
| `branch` | `claude/security-fixes`, `claude/code-quality` | Branch the pull request comes from. |
| `labels` | `security`/`code-quality` + `automated` | Pull request labels. |
| `force` | `false` | security: triage findings earlier pull requests covered, replacing an open one. quality: replace the open pull request. |
| `pr-token` | | A token to push and open pull requests with instead of `GITHUB_TOKEN`. Changes pushed with `GITHUB_TOKEN` don't trigger your other workflows, and `GITHUB_TOKEN` can't change files in `.github/workflows/`. A fine-grained token with contents, pull requests and workflows write fixes both. |
| `resume-workflow` | `claude-resume.yml` | File name of the resume workflow to turn on when a run pauses. |
| `semgrep-config` | `p/default p/secrets p/github-actions` | security: rulesets or config files. |
| `semgrep-version` | `1.180.0` | security: Semgrep version installed with pipx. |
| `upload-sarif` | `true` | security: upload findings to code scanning. |
| `max-findings` | `20` | security: most findings triaged in one pull request. |
| `areas` | whole repository | quality: folders to work through, one per line. |
| `area` | | quality: work on this folder now instead of continuing the rotation. |
| `exclude` | | quality: paths Claude must not change, one per line. |
| `extensions` | common languages | quality: file extensions that count as source code. |
| `batch-lines` | `1500` | quality: roughly how many lines one pass covers. |
| `pull-request-mode` | `commit` | quality on pull requests: `commit` to the branch, or open a separate `pull-request` into it. |
| `pull-request-authors` | repository owner | quality on pull requests: whose pull requests to refactor, one per line. |
| `instructions` | | quality: extra guidance added to the prompt. |

Outputs: `findings`, `files`, `pull-request-url`, `paused`, `resume-at`, `claude-cost-usd` and, for resume, `resumed`.

## Permissions

| Task | Needs |
| --- | --- |
| security | `contents: write`, `pull-requests: write`, `security-events: write`, `actions: write` |
| quality | `contents: write`, `pull-requests: write`, `actions: write`, `checks: read` |
| resume | `actions: write`, `checks: read`, `contents: read` |

`actions: write` lets a paused run cancel itself and turn on the resume workflow. `checks: read` lets the action read the notes it leaves on runs (where a pass stopped, when a pause ends).

## Security notes

- On the default branch, Claude runs from schedules, pushes and manual runs. On pull requests, only quality runs, and only for same-repository pull requests by the people you list.
- Claude gets file tools (read, edit, search) and Bash restricted to a handful of commands: your `verify-command`, the Semgrep re-scan, and read-only `git diff`/`git status`/`git log`. It can't start subagents, browse the web, or push.
- The action's inputs, `GITHUB_TOKEN` and runner tokens are removed from the environment Claude and your `verify-command` see. Claude can't read `.git/`, and the examples check out with `persist-credentials: false` so no token is left in the checkout.
- The repository's own `CLAUDE.md` and `.claude/settings.json` are loaded, so whoever can change those can steer Claude. That's normally only you.
- Everything Claude does arrives as a pull request or a commit on your own pull request. Nothing reaches your default branch without you.

## Troubleshooting

**"Claude isn't enabled for this repository"**
The secret is missing or not passed to the action. Runs triggered by Dependabot or from forks never receive secrets.

**"GitHub refused to open the pull request"**
Turn on **Allow GitHub Actions to create and approve pull requests** (step 3), or pass a `pr-token`.

**"Dropped Claude's change to …"**
Claude edited a file outside its batch, an excluded path, or a workflow file (which `GITHUB_TOKEN` can't push). Pass a `pr-token` with workflows permission to allow workflow fixes.

**"verify-command failed after Claude's changes"**
Nothing was pushed. The attempted diff is in the run log.

**A paused run never restarted**
Check that `claude-resume.yml` exists, matches `resume-workflow`, and has `actions: write` and `checks: read`. Paused runs are also picked up by the next scheduled run.

## Versioning

Releases follow semantic versioning. Each release is tagged `vMAJOR.MINOR.PATCH`, and the major tag (such as `v1`) moves to the newest release, so `@v1` gets fixes without breaking changes. The bundled Claude Code version follows `@anthropic-ai/claude-agent-sdk`, which Dependabot keeps current.

## License

MIT. See [LICENSE](LICENSE).
