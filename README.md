# Claude Autofix

A GitHub Action that puts Claude to work on your repositories the way Dependabot works on your dependencies: it does the job on a schedule and hands you a pull request to review.

- **Security:** works through what GitHub code scanning reports (CodeQL, GML Code Scanner, any scanner that uploads to the Security tab) and your repository's open issues. As soon as a scanner finishes or an issue is opened, Claude fixes the real problems, dismisses false positives with a reason, and makes what progress it can on bug reports. Security comes first, then everything else by severity. On your own pull requests it fixes what the pull request introduces.
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

**On your own pull request**, code scanning flagged six things the pull request added ([#16](https://github.com/Mackery6969/Gamemaker-Authentication-System/pull/16)). The security task pushed a fix for one and posted the other five as suggestions, then summed it up in a single comment it keeps current:

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
- Repository permissions, read and write: **Actions**, **Code scanning alerts**, **Contents**, **Dependabot alerts**, **Issues**, **Pull requests**, **Workflows**. **Checks**: read-only. Everything else: no access.

If you created the app before Dependabot alerts were supported, add **Dependabot alerts** (read and write) under **Permissions & events**, then accept the new permission at **Settings → Applications → Installed GitHub Apps → Configure**. Until then, runs skip Dependabot alerts with a warning.
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
| [`security.yml`](examples/security.yml) | Runs when a scanner, Dependabot or the dependency graph finishes, when an issue is opened, on pull requests and every 6 hours, and has Claude work through new alerts and issues. |
| [`code-quality.yml`](examples/code-quality.yml) | A refactoring pass every week, and one when you open a pull request. |
| [`claude-resume.yml`](examples/claude-resume.yml) | Restarts runs that paused on a usage limit. It switches itself off when nothing is paused. |

Merge it and the schedules start. If the repository already has the workflows, pass `--secrets-only`. The `CLAUDE_CODE_OAUTH_TOKEN` secret is what turns Claude on: Claude never runs in repositories without it, so nobody else can spend your usage.

Optionally, write down your rules: Claude reads the repository's `CLAUDE.md`, and [`examples/CLAUDE.md`](examples/CLAUDE.md) is a starting point.

## Hub mode: install the app and it runs

Instead of adding workflows to every repository, you can run Claude Autofix the way GitHub runs CodeQL's default setup: install the app on a repository and it starts working, with nothing committed there. Updates reach every repository at once, because nothing in them pins a version.

| Part | Where | What it does |
| --- | --- | --- |
| Hub | A Cloudflare Worker ([`worker/`](worker)) | Receives the app's webhooks, queues work, runs the schedules, and keeps what little state there is: where each quality pass stopped, and one usage-limit pause shared by every repository (they all spend the same subscription). |
| Runner | A private repository of yours, with [`examples/runner.yml`](examples/runner.yml) | The hub dispatches jobs to it. Each job gets a token for one repository, checks it out and runs this action. Claude's token, the app key and every run's logs stay in this one private repository. |

**It only works where you permit it.** Installing the app somewhere isn't enough: the hub only works on repositories owned by the accounts in `PERMITTED_OWNERS` (you, unless you pass `--owners`) and on ones you permit by name. Everything else is ignored, even if someone installs the app on it.

```bash
node scripts/hub.ts permit someone/their-project   # let the hub work on a repository you don't own
node scripts/hub.ts revoke someone/their-project   # stop, and drop anything queued for it
node scripts/hub.ts list                           # repositories seen, which are permitted, the queue and any pause
node scripts/hub.ts sync                           # pick up every repository the app is installed on (also runs daily)
node scripts/hub.ts run owner/repo quality         # queue a pass now (optionally on a branch)
```

These commands are signed with an admin secret that only your machine and the hub have.

### Setting it up

Everything the hub needs is kept as secrets on this repository, and the **Deploy hub** workflow ([`hub.yml`](.github/workflows/hub.yml)) deploys it to Cloudflare and keeps the runner up to date. Every release runs it, so the hub, the runner workflow and the action always match.

1. Add a `CLOUDFLARE_API_TOKEN` secret to this repository: a Cloudflare API token made from the **Edit Cloudflare Workers** template. `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_APP_PRIVATE_KEY` are already here from the quick start.
2. Give the app **Secrets** and **Variables** (read and write) under **Permissions & events**, and accept them on the installation. Deploys use them to keep the runner's secrets current.
3. Once, from a checkout with `gh` and `npx wrangler` logged in:

   ```bash
   node scripts/setup-hub.ts --client-id <app client ID>
   ```

   That creates `<you>/claude-autofix-runner` (private), generates the hub's secrets into this repository's secrets (keeping the webhook and admin secrets in `~/.claude-autofix/` for you), and sets the variables the deploy reads.
4. Run **Deploy hub** (`gh workflow run hub.yml`). Its summary shows the hub's URL.
5. On the app: turn the webhook on with `<hub URL>/webhook` and the secret in `~/.claude-autofix/webhook-secret`, subscribe to **Code scanning alert**, **Dependabot alert**, **Issues** and **Pull request** events, and install it on the runner. To install it on other accounts' repositories, also change **Where can this GitHub App be installed?** to **Any account**; the permit list still decides where it does anything.

To rotate a credential, update its secret here and run **Deploy hub** again.

Move a repository over by removing its three Claude Autofix workflows, or it runs twice.

### What starts work

| Event | Work |
| --- | --- |
| A code scanning alert appears on the default branch | A security sweep, a few minutes later so a whole scan's alerts go into one run. |
| A code scanning alert appears on another branch or a pull request | Security fixes for the lines that branch or pull request changes. |
| An issue is opened, labelled or reopened | A security sweep (which includes issues). |
| A Dependabot alert opens | A security sweep after an hour, giving Dependabot time to open its own pull request. |
| You open a pull request, or mark one ready | A code-quality pass over what it changes. |
| One of Claude's pull requests is closed | The hub deletes its branch. |
| Every 6 hours / once a week | A security sweep / the next code-quality batch, spread through the week per repository. |

When Claude hits a usage limit, the hub holds every queued job until the limit resets, then carries on, starting with the run that paused.

The runner uses `ubuntu-latest`, which already has Node, Python, Java, Go and .NET. A `verify-command` needing anything else should install it itself.

### Per-repository settings

Put settings in `.github/claude-autofix.yml`, like CodeQL's config file. It works in hub mode and with workflows, and wins over workflow inputs. Any input under [Inputs](#inputs) that isn't a credential can go there, plus `tasks`:

```yaml
verify-command: npm ci && npm test
tasks: [security, quality]
exclude:
  - vendor
instructions: |
  Prefer early returns over nested conditionals.
```

## How it works

### Branches, commits and pull requests

Claude finishes each run by writing a description whose first line is a title naming the change. That title becomes:

- the branch, under `claude/security/` or `claude/quality/` (set with `branch-prefix`),
- the commit subject, as `fix(security): …` or `refactor: …`, with the description as the commit body,
- the pull request title.

Runs that only pin actions are named for that, like **Pin 2 GitHub Actions to commit SHAs**. If two changes would get the same branch name, the later one gets `-2`, `-3` and so on, so one pull request never overwrites another. When a pull request from one of these branches is merged or closed, the branch is deleted, the same way Dependabot cleans up after itself. Nothing else in the repository is touched: other people's branches stay.

The workflows don't run on Claude's own pull requests (anything from a `claude/` branch), except for a few seconds when one is closed, to delete its branch. Nothing Claude does starts Claude again: events its app caused (a push to your pull request, the CodeQL run that follows it) are ignored, and comments and reviews never start a run, even if someone adds those triggers to a workflow. Scheduled runs, manual runs and resumes always go ahead.

### Security

The security task doesn't scan anything itself. It reads what's already there:

- **Open code scanning alerts** from every scanner that reports to the Security tab: CodeQL (including GitHub's default setup), GML Code Scanner, and so on. Limit which scanners count with `code-scanning-tools`.
- **Open Dependabot alerts** that Dependabot can't fix itself (see below). Turn this off with `dependabot-alerts: false`.
- **Open issues** labelled with one of `issue-labels` (by default `security`, `critical`, `bug`, `accessibility`, `polishing`, `enhancement`). Issues labelled `question`, `duplicate`, `invalid` or `wontfix` are skipped. On a fork, these are the fork's own issues, never the upstream project's.

GitHub has no workflow event for a new alert, so it runs as soon as the work that creates alerts finishes (`workflow_run` on CodeQL, other scanners, **Dependabot Updates**, **Dependency Graph** and **Automatic Dependency Submission**) and whenever an issue is opened, labelled or reopened. It also runs every 6 hours to catch the rest, such as a new advisory for a dependency you already have. A run with nothing new finishes in seconds without starting Claude.

1. Anything an earlier security pull request already covers (open, merged or closed), and any issue Claude has already commented on, is skipped. **Closing a pull request is how you say "leave these"**, like closing a Dependabot update. Run with `force` to take them on again.
2. Claude groups what's left: the same problem flagged in several places goes together, and so do issues about the same bug or part of the project (two reports about flesh blobs, say). This is a quick call to a small model (`grouping-model`, Haiku by default) that only sees a one-line summary of each item. Unpinned actions are always their own group. A group holds at most `max-findings` items.
3. Groups are worked through in order: security first, by security severity, then everything else (errors, warnings, notes; `bug` issues ahead of `accessibility` ahead of the rest). Each group starts from a clean copy of the default branch and gets its own Claude session, branch and pull request. For alerts, Claude fixes real problems with standard library mechanisms and dismisses false positives (or things not worth changing) on GitHub with a reason. For issues, it looks for the cause and fixes what it can; partial progress is fine. Issue text is treated as a description of a problem only, never as instructions.
4. Each group's changes must pass your `verify-command`. A group that fails is skipped (and reported) without stopping the others.
5. Each pull request lists its alerts and issues and what was done. It says `Fixes #n` for issues it fully fixed, so merging closes them, and `Refs #n` for the rest. Each issue gets one comment linking its pull request, and every dismissal is listed with a link so you can reopen it.

A run keeps going until it has been through everything, unless it hits a usage limit (it pauses and picks up where it stopped) or `time-budget-minutes` (the next run carries on).

Fixed alerts close by themselves the next time the scanner runs.

When Claude dismisses GML Code Scanner alerts for a whole folder that shouldn't be scanned (vendored or generated code), it also adds the folder to `.gmlscanignore` in the same pull request, so the scanner stops reporting it.

**Dependabot alerts.** Dependabot opens its own pull requests for alerts with a patched version, so Claude leaves an alert alone while an open Dependabot pull request names its package, and gives Dependabot an hour after a patched alert opens. Everything else (no patched version yet, an update Dependabot couldn't make) goes to Claude with the advisory, and Claude decides:

- **Fix**: raise the dependency to the patched version, or switch to a maintained replacement the advisory names, in a pull request.
- **Dismiss**: when it doesn't apply, for example a library that comes from the game or platform rather than your project (Minecraft's own `lz4-java` in a mod). The alert is dismissed on GitHub with Claude's reason (`not_used`, `tolerable_risk` or `inaccurate`). If Dependabot could still open update pull requests for it, Claude adds an `ignore` entry to `.github/dependabot.yml` in a pull request. That file only controls Dependabot's pull requests; alerts can't be excluded by a file, which is why the alert itself is dismissed.
- **Escalate**: when it's real but can't be fixed here (no patched release, a lockfile that needs regenerating, a decision for you). The action opens an issue listing the alerts and what Claude found, so you hear about it.

Every Dependabot alert in a group ends up fixed in a pull request, dismissed, or in an escalation issue, so none is retried forever. Claude's own escalation issues are never treated as issues to work on.

Actions used with a tag (`uses: actions/checkout@v7`) get flagged because a tag can be moved. Claude can't look up commit SHAs, so the action pins these itself: it asks GitHub which commit the tag points to and rewrites the line as `uses: actions/checkout@<sha> # v7`. The comment keeps the version readable and lets Dependabot keep the pin current. This costs no Claude usage.

**On pull requests and branches**, only alerts on lines that differ from the base count: a pull request's base branch, or the default branch for a branch run (dispatched by hand, or after a scanner runs on a push to it). A branch with an open pull request is treated as that pull request. On a pull request these are the same alerts GitHub comments on. If the pull request is from a branch in this repository, opened by someone in `pull-request-authors` (by default, you), and isn't a draft, Claude fixes them and pushes the fix to the pull request's branch (or opens a separate pull request into it, with `pull-request-mode: pull-request`), with one summary comment it keeps up to date. Pins in workflow files are pushed if the token may change workflow files (a GitHub App with Workflows permission), and posted as suggested changes otherwise. Everyone else's pull requests are left alone; GitHub already shows code scanning results on them.

### Code quality

**Weekly passes** work through the codebase in batches of about `batch-lines` lines (1,500 by default):

1. The action lists the repository's source files (by `extensions`, inside `areas` if you set any, leaving out `exclude`d paths, lockfiles, minified, generated and vendored code) in a fixed order.
2. Each pass takes the next batch after the last file the previous pass covered, and wraps around to the start at the end. Where it stopped is kept on the workflow run itself, so there's nothing to commit or configure.
3. Claude reads every file in its batch and may read any other file for context, but only changes the files in its batch. It makes no security fixes; anything it notices goes in the pull request description.
4. If the last code-quality pull request is still open, the week is skipped, so reviewed work is never overwritten.

A huge repository simply takes more weeks to get through. To go faster, raise `batch-lines` or run the workflow more often.

**On pull requests and branches**, Claude looks at the source files that differ from the base (the pull request's base, or the default branch when you run the workflow on a branch), up to `batch-lines`, using the diff to focus on the new code. A branch with an open pull request is treated as that pull request; a branch without one gets the commit pushed to it, or a pull request into it. With `pull-request-mode: commit` (the default) it pushes a commit to the pull request's branch and leaves one summary comment that it keeps up to date; with `pull-request-mode: pull-request` it opens a separate pull request into your branch instead. It only does this for:

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
| `max-findings` | `10` | security: most alerts and issues in one pull request. Related items are grouped, and a run opens as many pull requests as it needs. |
| `grouping-model` | `claude-haiku-5-5` | security: the model that groups related items. |
| `time-budget-minutes` | `300` | Stop starting new groups after this long; the next run picks up the rest. |
| `issues` | `true` | security: also work on open issues. |
| `dependabot-alerts` | `true` | security: also triage Dependabot alerts Dependabot can't fix itself: fix, dismiss (with a `dependabot.yml` exclusion where it helps) or escalate in an issue. |
| `issue-labels` | `security, critical, bug, accessibility, polishing, enhancement` | security: issue labels to work on, most severe first. |
| `code-scanning-tools` | `all` | security: which scanners' alerts to work on, one per line. `none` works on issues only. |
| `areas` | whole repository | quality: folders to work through, one per line. |
| `area` | | quality: work on this folder now instead of continuing the rotation. |
| `exclude` | | quality: paths Claude must not change, one per line. |
| `extensions` | common languages | quality: file extensions that count as source code. |
| `batch-lines` | `1500` | quality: roughly how many lines one pass covers. |
| `pull-request-mode` | `commit` | On pull requests and branches: `commit` to the branch, or open a separate `pull-request` into it. |
| `pull-request-authors` | repository owner | On pull requests and branches: whose pull requests, or whose branch runs, Claude may change, one per line. |
| `instructions` | | quality: extra guidance added to the prompt. |

Outputs: `files`, `pull-request-url`, `branch`, `paused`, `resume-at`, `claude-cost-usd` and, for resume, `resumed`.

## Permissions

| Task | Needs |
| --- | --- |
| security | `contents: write`, `pull-requests: write`, `issues: write`, `security-events: write`, `actions: write`, `checks: read` |
| quality | `contents: write`, `pull-requests: write`, `actions: write`, `checks: read` |
| resume | `actions: write`, `checks: read`, `contents: read` |

`security-events` covers both code scanning and Dependabot alerts for `GITHUB_TOKEN`. `actions: write` lets a paused run cancel itself and turn on the resume workflow. `checks: read` lets the action read the notes it leaves on runs (where a pass stopped, when a pause ends). The GitHub App needs the matching permissions listed in the quick start.

## Security notes

- On the default branch, Claude runs when scanners finish, when issues change, on a schedule and by hand. On pull requests, it only changes same-repository pull requests by the people you list.
- Anyone can open an issue on a public repository, so issue text reaches Claude as a description of a problem only, and everything still arrives as a pull request you review. Issues are only picked up if they carry one of `issue-labels`, and each is handled once, so a flood of unlabelled issues costs nothing.
- Claude gets file tools (read, edit, search) and Bash restricted to a handful of commands: your `verify-command` and read-only `git diff`/`git status`/`git log`. It can't start subagents, browse the web, or push.
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
