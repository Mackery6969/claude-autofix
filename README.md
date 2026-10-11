# Claude Autofix

A GitHub Action that puts Claude to work on your repositories the way Dependabot works on your dependencies: it does the job on a schedule and hands you a pull request to review.

- **Security:** scans with [Semgrep](https://semgrep.dev) on every push, every pull request, every week and on demand. Claude triages new findings: real flaws get fixed with standard library mechanisms, false positives get an explained `nosemgrep` suppression. On your own pull requests it fixes what the pull request introduces; on anyone else's it comments with what it found. Findings also go to **Security → Code scanning**.
- **Code quality:** once a week, Claude makes a small, behaviour-preserving refactoring pass over the next batch of files, working through the whole codebase a batch at a time, so even large repositories stay cheap and reviewable. On your own pull requests, it tidies the code the pull request changes.
- **Runs on your Claude subscription.** Hitting a usage limit doesn't fail anything: the run marks itself paused, shows as cancelled, and starts again by itself once the limit resets, whether that's the 5-hour window or the weekly one.

Every change gets a branch, commit and pull request named after what it does, its branch is deleted once the pull request is merged or closed, and nothing is merged for you. Security fixes and refactoring never share a pull request.

## What it looks like

These come from [GameMaker Authentication System](https://github.com/Mackery6969/Gamemaker-Authentication-System), which runs this action.

**A weekly code-quality pass** reads its batch of files, makes one focused change and opens a pull request for it:

| | |
| --- | --- |
| Branch | `claude/quality/use-a-guard-clause-in-load-env` |
| Commit | `refactor: use a guard clause in load_env` |
| Pull request | **Use a guard clause in load_env** · `code-quality` `automated` |

```diff
         for line in f:
             m = line.strip()
-            if m and not m.startswith("#") and "=" in m:
-                k, v = m.split("=", 1)
-                env[k.strip()] = v.strip()
+            if not m or m.startswith("#") or "=" not in m:
+                continue
+            k, v = m.split("=", 1)
+            env[k.strip()] = v.strip()
```

The pull request description says what changed in each file and why behaviour is the same, lists anything Claude noticed but left alone, and ends with whether `verify-command` passed and what the run cost.

**On your own pull request**, Semgrep flagged six things the pull request added ([#16](https://github.com/Mackery6969/Gamemaker-Authentication-System/pull/16)). The security task pushed a fix for one and posted the other five as suggestions, then summed it up in a single comment it keeps current:

> ### Add a 7-day Dependabot cooldown for GitHub Actions
>
> | Rule | File:Line | Verdict | Reason |
> | --- | --- | --- | --- |
> | `dependabot-missing-cooldown` | `.github/dependabot.yml:14` | Fixed | Added `cooldown: default-days: 7`, as the rule recommends. |
>
> Suggested as changes on this pull request, because workflow files can't be pushed without a token that may change them:
>
> - `.github/workflows/security.yml:32` actions/checkout@v7 → `3d3c42e5aac5`
> - …
>
> verify-command passed. Claude usage: $0.11 (API-equivalent).

Each suggestion is one click to commit:

```suggestion
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
```

**On someone else's pull request**, or one from a fork, nothing is changed: the findings on the lines it adds are annotated in the diff and listed in a comment.

## Quick start

Claude's commits, pull requests and comments come from a GitHub App, so they show up under its own name, their checks run without needing approval, and it can fix workflow files. The workflows fall back to `GITHUB_TOKEN` (showing as `github-actions[bot]`) wherever the app's key isn't available, such as pull requests from forks.

### Once

**1. Create the GitHub App.** At **Settings → Developer settings → GitHub Apps → New GitHub App**:

- Any name (it becomes `<name>[bot]`) and any homepage URL.
- Untick **Webhook → Active**.
- Repository permissions, read and write: **Actions**, **Code scanning alerts**, **Contents**, **Issues**, **Pull requests**, **Workflows**. **Checks**: read-only. Everything else: no access.
- **Only on this account.**

Then **Generate a private key**, and **Install App** on **All repositories**. The app does nothing in a repository until that repository's workflows have its key, and installing it everywhere means new repositories need no extra step. Put the app's **Client ID** in the `client-id:` lines of the files in [`examples/`](examples).

**2. Keep the two credentials in one place.** Save your Claude token (from `claude setup-token`) to `~/.claude-autofix/claude-oauth-token`, and the app's private key file as `~/.claude-autofix/app-private-key.pem`. Both are long-lived, so keep that folder private; you can regenerate either at any time. To keep them elsewhere, set `CLAUDE_AUTOFIX_TOKEN_FILE` and `CLAUDE_AUTOFIX_KEY_FILE`.

### For each repository

From a checkout of this repository:

```bash
node scripts/enable-repo.ts owner/repo --verify "npm ci && npm test"
```

That sets the repository's `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_APP_PRIVATE_KEY` secrets and opens a pull request adding the three workflows, with your `verify-command` filled in:

| Workflow | What it does |
| --- | --- |
| [`security.yml`](examples/security.yml) | Scans on push, pull request, weekly and on demand, and has Claude fix what it finds. |
| [`code-quality.yml`](examples/code-quality.yml) | A refactoring pass every week, and one when you open a pull request. |
| [`claude-resume.yml`](examples/claude-resume.yml) | Restarts runs that paused on a usage limit. It switches itself off when nothing is paused. |

Merge it and the schedules start. If the repository already has the workflows, pass `--secrets-only`. The `CLAUDE_CODE_OAUTH_TOKEN` secret is what turns Claude on: repositories without it still get the Semgrep scan, but Claude never runs there, so nobody else can spend your usage.

Optionally, write down your rules: Claude reads the repository's `CLAUDE.md`, and [`examples/CLAUDE.md`](examples/CLAUDE.md) is a starting point.

## How it works

### Branches, commits and pull requests

Claude finishes each run by writing a description whose first line is a title naming the change. That title becomes:

- the branch, under `claude/security/` or `claude/quality/` (set with `branch-prefix`),
- the commit subject, as `fix(security): …` or `refactor: …`, with the description as the commit body,
- the pull request title.

Runs that only pin actions are named for that, like **Pin 2 GitHub Actions to commit SHAs**. When a pull request from one of these branches is merged or closed, the branch is deleted, the same way Dependabot cleans up after itself. Nothing else in the repository is touched: other people's branches stay.

### Security

1. Semgrep scans the checkout (`p/default`, `p/secrets` and `p/github-actions` unless you set `semgrep-config`) and uploads the results to code scanning.
2. On the default branch, it carries on with the steps below. Pull requests are covered further down; other branches are only scanned.
3. Each finding gets a key from its rule, its file and the code it flags, so unrelated edits that move it to another line don't make it "new", but changing the flagged code does.
4. Findings an earlier security pull request already covered (open, merged or closed) are skipped. **Closing that pull request is how you say "ignore these"**, like closing a Dependabot update. Run with `force` to triage them again.
5. Up to `max-findings` of the rest, most severe first, go to Claude. It fixes or suppresses each one, re-runs Semgrep, and runs your `verify-command`.
6. The result is opened as a pull request with a table of every finding and what was done about it. While it's open, no new security pull request is started; the next batch follows once you merge or close it.

**Other scanners.** The security task also works through open **code scanning alerts** from your other scanners: GML Code Scanner, CodeQL, anything that uploads to the Security tab (Semgrep's own uploads are skipped, since the action already has those findings). Security alerts come first, ranked by security severity alongside the Semgrep findings, then everything else the scanners report (bugs, performance, maintainability), ranked by error, warning, note. Claude fixes what it can; it may resolve a non-security issue only partly, as long as the pull request says what's left. For a false positive, or something not worth changing, it dismisses the alert on GitHub with a reason, and the pull request (or run summary) lists every dismissal with a link, so you can reopen any you disagree with. Fixed alerts close themselves once the scanner sees the fix. Limit which scanners count with `code-scanning-tools`. To react as soon as a scanner reports something, add its workflow to the security workflow's triggers:

```yaml
  workflow_run:
    workflows: ["GML Code Scanner"]
    types: [completed]
```

Actions used with a tag (`uses: actions/checkout@v7`) are flagged by Semgrep because a tag can be moved. Claude can't look up commit SHAs, so the action pins these itself: it asks GitHub which commit the tag points to and rewrites the line as `uses: actions/checkout@<sha> # v7`. The comment keeps the version readable and lets Dependabot keep the pin current. This costs no Claude usage. Exclude the rule with `semgrep-exclude-rules` if you'd rather keep tags.

**On pull requests**, only findings on lines the pull request adds or changes count, the same ones GitHub comments on.

- If the pull request is from a branch in this repository, opened by someone in `pull-request-authors` (by default, you), and isn't a draft, Claude fixes those findings and pushes the fix to the pull request's branch (or opens a separate pull request into it, with `pull-request-mode: pull-request`), with one summary comment it keeps up to date. Pins in workflow files are pushed if the token may change workflow files (a GitHub App with Workflows permission), and posted as suggested changes otherwise.
- Otherwise (forks, other people's pull requests, drafts, or no Claude secret), nothing is changed. The findings are annotated on the changed lines and listed in a comment on the pull request. Pull requests from forks only get a read-only token, so for them the annotations are all there is.

### Code quality

**Weekly passes** work through the codebase in batches of about `batch-lines` lines (1,500 by default):

1. The action lists the repository's source files (by `extensions`, inside `areas` if you set any, leaving out `exclude`d paths, lockfiles, minified, generated and vendored code) in a fixed order.
2. Each pass takes the next batch after the last file the previous pass covered, and wraps around to the start at the end. Where it stopped is kept on the workflow run itself, so there's nothing to commit or configure.
3. Claude reads every file in its batch and may read any other file for context, but only changes the files in its batch. It makes no security fixes; anything it notices goes in the pull request description.
4. If the last code-quality pull request is still open, the week is skipped, so reviewed work is never overwritten.

A huge repository simply takes more weeks to get through. To go faster, raise `batch-lines` or run the workflow more often.

**On pull requests**, Claude looks at the source files the pull request changes, up to `batch-lines`, using the pull request's diff to focus on the new code. With `pull-request-mode: commit` (the default) it pushes a commit to the pull request's branch and leaves one summary comment that it keeps up to date; with `pull-request-mode: pull-request` it opens a separate pull request into your branch instead. It only does this for:

- pull requests from branches in the same repository (never forks),
- opened by someone in `pull-request-authors` (by default, the repository owner), so collaborators' pull requests don't spend your usage,
- that aren't drafts or opened by bots, and whose latest commit isn't already Claude's.

It never force-pushes your branch: if you pushed while Claude was working, it stops and leaves your commits alone. The example runs once when a pull request is opened or marked ready; add `synchronize` to its `types` to run on every push, at the cost of more usage.

### Usage limits

When Claude reports a usage limit, the run:

1. Records when the limit resets in a `claude-paused` notice on the run.
2. Turns on the resume workflow.
3. Cancels itself, so it shows as cancelled rather than failed. Nothing is committed.

Every 30 minutes while something is paused, the resume workflow checks each workflow's latest runs. Once the reset time has passed, it starts a fresh run on the default branch (or re-runs a paused pull request run). When nothing is left waiting, it turns itself off, so it costs nothing while idle. If that fresh run hits the limit again (a weekly limit, say), it pauses again with the new reset time.

The action never sleeps in a job waiting for a limit, and Claude can't start subagents, so a run doesn't quietly multiply its usage.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `task` | | `security`, `quality` or `resume`. |
| `claude-code-oauth-token` | | Your subscription token from `claude setup-token`. Without it (or `anthropic-api-key`), Claude is off. |
| `anthropic-api-key` | | Anthropic API key, billed per use. |
| `github-token` | `GITHUB_TOKEN` | Token for the GitHub API and pushes. Pass a GitHub App token to give Claude its own identity. |
| `app-slug` | | The GitHub App's slug, from `actions/create-github-app-token`. Commits are then made as the app, and workflow files can be changed. |
| `model` | `claude-opus-5-5` (security), `claude-sonnet-5-5` (quality) | Claude model. |
| `max-budget-usd` | `5` (security), `3` (quality) | Stop Claude once a run has used this much, at API prices. On a subscription it caps how much of your usage one run can take. |
| `verify-command` | | Shell commands that must pass after Claude's changes, such as `npm ci && npm test`. Claude runs it too, and fixes or reverts what breaks it. Keep its build output gitignored. |
| `branch-prefix` | `claude/security`, `claude/quality` | Folder for Claude's branches. |
| `labels` | `security`/`code-quality` + `automated` | Pull request labels. |
| `force` | `false` | security: triage findings earlier pull requests covered, replacing an open one. quality: start a pass even if the last pull request is still open. |
| `pr-token` | | A personal access token to push and open pull requests with. A GitHub App (above) does the same job with short-lived tokens. |
| `resume-workflow` | `claude-resume.yml` | File name of the resume workflow to turn on when a run pauses. |
| `semgrep-config` | `p/default p/secrets p/github-actions` | security: rulesets or config files. |
| `semgrep-exclude-rules` | | security: rule ids to leave out, such as `yaml.github-actions.security.github-actions-mutable-action-tag.github-actions-mutable-action-tag` if you don't want actions pinned to commit SHAs. |
| `semgrep-version` | `1.180.0` | security: Semgrep version installed with pipx. |
| `upload-sarif` | `true` | security: upload findings to code scanning. |
| `max-findings` | `20` | security: most findings triaged in one pull request, across Semgrep and other scanners. |
| `code-scanning-tools` | `all` | security: which other scanners' alerts to fix or dismiss, one per line. `all` means every scanner but Semgrep; `none` turns it off. |
| `areas` | whole repository | quality: folders to work through, one per line. |
| `area` | | quality: work on this folder now instead of continuing the rotation. |
| `exclude` | | quality: paths Claude must not change, one per line. |
| `extensions` | common languages | quality: file extensions that count as source code. |
| `batch-lines` | `1500` | quality: roughly how many lines one pass covers. |
| `pull-request-mode` | `commit` | On pull requests: `commit` to the branch, or open a separate `pull-request` into it. |
| `pull-request-authors` | repository owner | On pull requests: whose pull requests Claude may change, one per line. |
| `instructions` | | quality: extra guidance added to the prompt. |

Outputs: `findings`, `files`, `pull-request-url`, `branch`, `paused`, `resume-at`, `claude-cost-usd` and, for resume, `resumed`.

## Permissions

| Task | Needs |
| --- | --- |
| security | `contents: write`, `pull-requests: write`, `security-events: write`, `actions: write` |
| quality | `contents: write`, `pull-requests: write`, `actions: write`, `checks: read` |
| resume | `actions: write`, `checks: read`, `contents: read` |

`actions: write` lets a paused run cancel itself and turn on the resume workflow. `checks: read` lets the action read the notes it leaves on runs (where a pass stopped, when a pause ends). The GitHub App needs the matching permissions listed in the quick start.

## Security notes

- On the default branch, Claude runs from schedules, pushes and manual runs. On pull requests, it only changes same-repository pull requests by the people you list; everyone else's just get a findings comment.
- Claude gets file tools (read, edit, search) and Bash restricted to a handful of commands: your `verify-command`, the Semgrep re-scan, and read-only `git diff`/`git status`/`git log`. It can't start subagents, browse the web, or push.
- The action's inputs, tokens and runner credentials are removed from the environment Claude and your `verify-command` see. Claude can't read `.git/`, and the examples check out with `persist-credentials: false` so no token is left in the checkout.
- Only branches in your own repository count as Claude's, so a fork can't pass off a branch named `claude/security/...` as an earlier triage.
- The repository's own `CLAUDE.md` and `.claude/settings.json` are loaded, so whoever can change those can steer Claude. That's normally only you.
- Everything Claude does arrives as a pull request or a commit on your own pull request. Nothing reaches your default branch without you.

## Troubleshooting

**"Claude isn't enabled for this repository"**
The secret is missing or not passed to the action. Runs triggered by Dependabot or from forks never receive secrets.

**"GitHub refused to open the pull request"**
Use the GitHub App from the quick start, or turn on **Allow GitHub Actions to create and approve pull requests**.

**Checks on Claude's pull requests say "approve workflows to run"**
GitHub holds runs triggered by `GITHUB_TOKEN` until someone approves them. Approving is safe: the action won't run Claude again on its own commits. A GitHub App avoids it.

**"Dropped Claude's change to …"**
Claude edited a file outside its batch, an excluded path, or a workflow file without a token that may change workflow files.

**"verify-command failed after Claude's changes"**
Nothing was pushed. The attempted diff is in the run log.

**A paused run never restarted**
Check that `claude-resume.yml` exists, matches `resume-workflow`, and has `actions: write` and `checks: read`. Paused runs are also picked up by the next scheduled run.

## Versioning

Releases follow semantic versioning. Each release is tagged `vMAJOR.MINOR.PATCH`, and the major tag (such as `v1`) moves to the newest release, so `@v1` gets fixes without breaking changes. The bundled Claude Code version follows `@anthropic-ai/claude-agent-sdk`, which Dependabot keeps current.

## License

MIT. See [LICENSE](LICENSE).
