# Claude Autofix

Puts Claude to work on your repositories the way CodeQL's default setup and Dependabot work: install a GitHub App on a repository and it starts, with nothing to commit there, and every change it makes arrives as a pull request for you to review.

- **Security:** works through security alerts from GitHub code scanning (CodeQL, GML Code Scanner, any scanner that uploads to the Security tab), Dependabot alerts Dependabot can't fix itself, and issues labelled `security` or `critical`. As soon as one appears, Claude fixes the real problems and dismisses false positives with a reason. On your own pull requests and branches, it fixes what they introduce. Security always goes first.
- **Fixes:** the same for everything else: scanner errors, warnings and notes, and bug, accessibility, polishing and enhancement issues, where Claude makes what progress it can.
- **Scanning:** Claude also reads your code itself, looking for vulnerabilities and bugs the scanners miss. It works through the whole project a few batches at a time, spread out so it doesn't use too much too fast, and can look at every push too, starting from what changed.
- **Code quality:** once a week, Claude makes a small, behaviour-preserving refactoring pass over the next batch of files, working through the whole codebase a batch at a time, so even large repositories stay cheap and reviewable. On your own pull requests, it tidies the code they change.
- **Conversations:** each of Claude's pull requests, and each issue it has taken part in, is a conversation. Comment, review or leave an inline note and Claude replies; ask for a change and it pushes it. Failed checks and new code scanning alerts on its own pull requests come back to it the same way.
- **Runs on your Claude subscription,** and only on repositories you choose. Hitting a usage limit doesn't fail anything: all work waits until the limit resets, then carries on.

Every change gets a branch, commit and pull request named after what it does, its branch is deleted once the pull request is merged or closed, and nothing is merged for you. Security fixes and refactoring never share a pull request.

## What it looks like

These come from [GameMaker Authentication System](https://github.com/Mackery6969/Gamemaker-Authentication-System).

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

**On your own pull request**, code scanning flagged things the pull request added ([#16](https://github.com/Mackery6969/Gamemaker-Authentication-System/pull/16)). The security task pushed fixes to the pull request's branch, pinned the actions it used to commit SHAs, and summed it up in a single comment it keeps current:

> ### Add a 7-day Dependabot cooldown for GitHub Actions
>
> | Rule | File:Line | Verdict | Reason |
> | --- | --- | --- | --- |
> | `dependabot-missing-cooldown` | `.github/dependabot.yml:14` | Fixed | Added `cooldown: default-days: 7`, as the rule recommends. |
>
> Pinned to the commit each tag points to today:
>
> - `.github/workflows/security.yml:32` actions/checkout@v7 → `3d3c42e5aac5`
> - …
>
> verify-command passed. Claude usage: $0.11 (API-equivalent).

**On someone else's pull request**, or one from a fork, nothing is changed. GitHub already shows code scanning results on it.

## How it fits together

| Part | Where | What it does |
| --- | --- | --- |
| GitHub App | Your account | Gives Claude its own identity and access to the repositories you install it on, and sends their events to the hub. |
| Hub | A Cloudflare Worker ([`worker/`](worker)) | Receives the app's webhooks, queues work, runs the schedules, and keeps what little state there is: where each quality pass stopped, and one usage-limit pause shared by every repository (they all spend the same subscription). |
| Workflows | One per task in each repository, added by the hub | Short files, so each task shows up in the repository's own **Actions** tab like CodeQL does: **Claude Security**, **Claude Fix**, **Claude Code Scanning**, **Claude Code Quality** and **Claude Conversations** (`.github/workflows/claude-<task>.yml`). Each calls [`.github/workflows/run.yml`](.github/workflows/run.yml) from this repository at `@v3`, which does the work. |
| Runner | A private repository of yours, with [`examples/runner.yml`](examples/runner.yml) | The fallback: the hub sends a repository's jobs here until its own workflows are in place, or if it can't add them. |

**Setting up a repository is installing the app on it.** Within a few minutes the hub commits a workflow for each task the repository's settings turn on to its default branch, in one commit. Those are the only files it ever commits there directly. Turn a task off in `.github/claude-autofix.yml` and the hub removes its workflow. The files hold no credentials. Each run proves to the hub which repository and workflow it is, with the OIDC token GitHub gives every run, and gets Claude's token and a GitHub token for that repository back. So a file only works when it calls this repository's shared workflow, from a repository the hub permits.

**Everything updates by itself.** The shared workflow and the action come from `@v3`, so a release reaches every repository at once. If the files themselves change (a new hub address, say), the hub rewrites them in each repository, a couple of repositories every 5 minutes. `node scripts/hub.ts list` shows each repository's workflows as current, out of date, not installed, or one the hub couldn't install. If the default branch only takes changes through pull requests, the hub opens one with the workflows (from `claude-autofix/workflows`) instead, and the repository keeps using the runner until you merge it. To let it update them directly next time, add the app to the ruleset's bypass list. Anything that couldn't be installed is tried again at the next daily sync, or straight away with `node scripts/hub.ts sync`.

In a public repository, the run logs are public, like its other workflow logs. Tokens are masked, but Claude's notes on the code are visible.

**It only works where you choose.** While the app is installable only on your account, installing it on a repository is how you turn it on there. The hub also only works on repositories owned by the accounts in `PERMITTED_OWNERS` (you) and on ones you permit by name, so even if you let other accounts install the app, it does nothing for them until you say so.

```bash
node scripts/hub.ts list                           # repositories seen, which are permitted, the queue and any pause
node scripts/hub.ts sync                           # pick up every repository the app is installed on (also runs daily)
node scripts/hub.ts run owner/repo scan            # queue security, fix, scan or quality now (optionally on a branch)
node scripts/hub.ts permit someone/their-project   # let the hub work on a repository you don't own
node scripts/hub.ts revoke someone/their-project   # stop, and drop anything queued for it
```

These commands are signed with an admin secret that only your machine and the hub have.

You can also run a task from a repository's own **Actions** tab: pick its workflow, such as **Claude Code Scanning**, then **Run workflow**. Choose the branch with **Use workflow from**, or give a pull request number (for **Claude Conversations**, a pull request or issue number). Leave the **hub** field empty; it's how the hub passes its jobs in. Both kinds of run go through the same workflow and the same hub. Only their names differ: the hub's runs say why they started ("Pull request #3", "Push to main", "Sweep of main"), and yours say "Run by <you> · …". A run you start and one the hub starts for the same branch or pull request take turns. Unlike `hub.ts run`, it starts right away, even while the hub is paused for a usage limit. Scan and quality runs started this way carry on from where the last pass stopped. If one hits a session or weekly limit, the hub starts it again once the limit resets, like any other run.

## Setting it up

**1. Create the GitHub App.** At **Settings → Developer settings → GitHub Apps → New GitHub App**, with any name (it becomes `<name>[bot]`) and any homepage URL:

- Repository permissions, read and write: **Actions**, **Code scanning alerts**, **Contents**, **Dependabot alerts**, **Issues**, **Pull requests**, **Secrets**, **Variables**, **Workflows**. Everything else: no access.
- Leave **Webhook → Active** unticked for now (step 5 turns it on).
- **Where can this GitHub App be installed?** **Only on this account.**

Then **Generate a private key**, and install the app on **Only select repositories**: this repository and the ones you want Claude to work on.

**2. Add three secrets to this repository:** `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), `CLAUDE_APP_PRIVATE_KEY` (the app's private key) and `CLOUDFLARE_API_TOKEN` (a Cloudflare API token from the **Edit Cloudflare Workers** template).

**3. Once, from a checkout with `gh` and `npx wrangler` logged in:**

```bash
node scripts/setup-hub.ts --client-id <app client ID>
```

That creates `<you>/claude-autofix-runner` (private), generates the hub's secrets into this repository's secrets (keeping the webhook and admin secrets in `~/.claude-autofix/` for you), and sets the variables the deploy reads. Install the app on the runner too.

**4. Deploy:** run **Deploy hub** (`gh workflow run hub.yml`). Its summary shows the hub's URL. From then on it runs by itself whenever a commit to `main` changes the hub, the runner workflow or the deploy scripts, and on every release.

**5. Connect the app:** turn its webhook on with `<hub URL>/webhook` and the secret in `~/.claude-autofix/webhook-secret`, and subscribe to **Code scanning alert**, **Dependabot alert**, **Issue comment**, **Issues**, **Pull request**, **Pull request review**, **Pull request review comment**, **Push** and **Workflow run** events.

The hub picks up the repositories within a day, or straight away with `node scripts/hub.ts sync`, and each gets its first security sweep within minutes.

To rotate a credential, update its secret here and run **Deploy hub** again. To add a repository, install the app on it; to stop, uninstall it.

Optionally, write down your rules: Claude reads each repository's `CLAUDE.md`, and [`examples/CLAUDE.md`](examples/CLAUDE.md) is a starting point.

### What starts work

| Event | Work |
| --- | --- |
| A code scanning alert appears on the default branch | A security sweep for a security alert, a fix sweep for anything else, a few minutes later so a whole scan's alerts go into one run. |
| A code scanning alert appears on another branch or a pull request | Security fixes or fixes for the lines that branch or pull request changes. |
| An issue is opened, labelled or reopened | A security sweep for `security` and `critical` issues, a fix sweep for the rest. |
| You push, with `scan-on-push` on | A scan of what the push changed, a couple of minutes later so quick pushes share one scan. |
| A Dependabot alert opens | A security sweep after an hour, giving Dependabot time to open its own pull request. |
| You open a pull request, or mark one ready | A code-quality pass over what it changes. Marking a draft ready (or reopening) also starts a security pass, for the alerts that appeared while it was a draft. |
| Someone comments on, or reviews, one of Claude's pull requests, comments on an issue Claude has taken part in, or mentions the app anywhere | A conversation: Claude replies, and changes what a maintainer asks for. See [Conversations](#conversations). |
| A check fails on one of Claude's pull requests, or a scan finds a new alert on a line it changed | A conversation: Claude reads the failing job's log or the alert and pushes a fix. |
| One of Claude's pull requests is closed | The hub deletes its branch. |
| On each repository's schedule | A security sweep and a fix sweep (every 6 hours), a scanning lap and a code-quality batch (every week), spread out per repository. |

Draft pull requests are left alone: code scanning still runs on them, but Claude doesn't change a branch you're still working on. Mark it ready and both passes run.

Nothing Claude does starts Claude again: the hub ignores comments and events the app caused. The one exception is a failed check on its own pull request, which it gets to fix, up to 3 times in a row.

The runner uses `ubuntu-latest` with Node 24 and Java 21 added; it already has Python, Go and .NET. A `verify-command` needing anything else should set it up itself.

## Per-repository settings

Put settings in `.github/claude-autofix.yml`, like CodeQL's config file. Every key is optional:

```yaml
verify-command: npm ci && npm test
tasks: [security, fix, scan, conversation]   # leave quality out to turn it off
fix-every: 1d
scan-on-push: true
scan-paths:
  - src/**
exclude:
  - vendor
instructions: |
  Prefer early returns over nested conditionals.
```

The hub reads this file from the default branch, and again whenever a push changes it.

| Setting | Default | Description |
| --- | --- | --- |
| `tasks` | all five | Which tasks run on this repository: `security`, `fix`, `scan`, `quality`, `conversation`. Leave one out to turn it off, schedule and all. |
| `security-every`, `fix-every`, `scan-every`, `quality-every` | `6h`, `6h`, `7d`, `7d` | How often each runs by itself, like `30m`, `6h`, `1d` or `2w` (15 minutes at least), or `off` to only run it on events or when asked. For `scan`, how long to wait between laps of the whole project. |
| `scan-on-push` | `false` | scan: also scan what each push changes, on any branch. |
| `scan-paths` | all source files | scan: only these paths, as patterns like `src/**` or `*.gml`, one per line. Push scans only start for pushes touching them. |
| `scan-branches` | all branches | scan: only scan pushes to these branches, as patterns. |
| `scan-lines` | `1500` | scan: how much one scan reads: lines of code per batch, or changed lines for a push or pull request. |
| `scan-batches` | `2` | scan: batches per scheduled run. |
| `scan-pace` | `1h` | scan: the gap between runs while a lap is under way. |
| `verify-command` | | Shell commands that must pass after Claude's changes, such as `npm ci && npm test`. Claude runs it too, and fixes or reverts what breaks it. Keep its build output gitignored. |
| `model` | `claude-opus-5-5` (security), `claude-sonnet-5-5` (quality) | Claude model. |
| `max-budget-usd` | `5` (security), `3` (quality) | Stop Claude once a run has used this much, at API prices. On a subscription it caps how much of your usage one run can take. |
| `branch-prefix` | `claude/security`, `claude/quality` | Folder for Claude's branches. |
| `labels` | `security`/`code-quality` + `automated` | Pull request labels. |
| `time-budget-minutes` | `300` | Stop starting new groups after this long; the next run picks up the rest. |
| `pull-request-mode` | `commit` | On pull requests and branches: `commit` to the branch, or open a separate `pull-request` into it. |
| `pull-request-authors` | repository owner | On pull requests and branches: whose changes Claude may change, one per line. |
| `max-findings` | `10` | security: most alerts and issues in one pull request. Related items are grouped, and a run opens as many pull requests as it needs. |
| `grouping-model` | `claude-haiku-5-5` | security: the model that groups related items. |
| `issues` | `true` | security: also work on open issues. |
| `dependabot-alerts` | `true` | security: also triage Dependabot alerts Dependabot can't fix itself: fix, dismiss (with a `dependabot.yml` exclusion where it helps) or escalate in an issue. |
| `issue-labels` | `security, critical, bug, accessibility, polishing, enhancement` | security: issue labels to work on, most severe first. |
| `code-scanning-tools` | `all` | security: which scanners' alerts to work on, one per line. `none` works on issues only. |
| `areas` | whole repository | quality: folders to work through, one per line. |
| `exclude` | | quality: paths Claude must not change, one per line. |
| `extensions` | common languages | quality: file extensions that count as source code. |
| `batch-lines` | `1500` | quality: roughly how many lines one pass covers. |
| `instructions` | | quality: extra guidance added to the prompt. |

## How it works

### Branches, commits and pull requests

Claude finishes each run by writing a description whose first line is a title naming the change. That title becomes:

- the branch, under `claude/security/`, `claude/fix/`, `claude/scan/` or `claude/quality/` (set with `branch-prefix`),
- the commit subject, as `fix(security): …` or `refactor: …`, with the description as the commit body,
- the pull request title.

Runs that only pin actions are named for that, like **Pin 2 GitHub Actions to commit SHAs**. If two changes would get the same branch name, the later one gets `-2`, `-3` and so on, so one pull request never overwrites another. When a pull request from one of these branches is merged or closed, the branch is deleted, the same way Dependabot cleans up after itself. Nothing else in the repository is touched: other people's branches stay.

### Security and fixes

The security and fix tasks work the same way, on different things: security takes alerts with a security severity, Dependabot alerts, and `security` and `critical` issues; fix takes every other alert and issue. They have their own queues, pull requests and settings, and the hub always runs security first. Neither scans anything itself (that's [Scanning](#scanning)). They read what's already there:

- **Open code scanning alerts** from every scanner that reports to the Security tab: CodeQL (including GitHub's default setup), GML Code Scanner, and so on. Limit which scanners count with `code-scanning-tools`.
- **Open Dependabot alerts** that Dependabot can't fix itself (see below). Turn this off with `dependabot-alerts: false`.
- **Open issues** labelled with one of `issue-labels` (by default `security`, `critical`, `bug`, `accessibility`, `polishing`, `enhancement`). Issues labelled `question`, `duplicate`, `invalid` or `wontfix` are skipped. On a fork, these are the fork's own issues, never the upstream project's.

The hub starts a sweep when an alert appears or an issue changes (see [What starts work](#what-starts-work)), and every 6 hours to catch the rest, such as a new advisory for a dependency you already have. A run with nothing new finishes in seconds without starting Claude.

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

**On pull requests and branches**, only alerts on lines that differ from the base count: a pull request's base branch, or the default branch for a branch (after a scanner runs on a push to it, or `node scripts/hub.ts run owner/repo security <branch>`). A branch with an open pull request is treated as that pull request. On a pull request these are the same alerts GitHub comments on. If the pull request is from a branch in this repository, opened by someone in `pull-request-authors` (by default, you), and isn't a draft, Claude fixes them and pushes the fix to the pull request's branch (or opens a separate pull request into it, with `pull-request-mode: pull-request`), with one summary comment it keeps up to date. Everyone else's pull requests are left alone; GitHub already shows code scanning results on them.

### Scanning

Here Claude reads the code itself, like a reviewer, looking for vulnerabilities (injection, missing authorization or validation, unsafe deserialization, path traversal, secrets, races) and real bugs (crashes, wrong results, leaks). It only reports problems it's confident are real, with a concrete way they go wrong, and fixes what it can with the smallest correct change.

**Laps of the whole project.** A scheduled or requested scan works through the repository's source files a batch at a time (about `scan-lines` lines each), picking up where the last batch stopped, so every file gets read in turn without spending much at once:

1. Each run scans `scan-batches` batches, each in its own Claude session, and the hub saves where it stopped after every batch.
2. Until the lap is done, the hub queues the next run `scan-pace` later (an hour by default), so a large project is scanned steadily over hours or days instead of all at once.
3. When a usage limit hits mid-lap, the run stops and the hub starts again from the same place once the limit resets.
4. Once every file has been scanned, the next lap starts `scan-every` later (a week by default).

**Pushes, pull requests and branches.** With `scan-on-push`, each push is scanned too, but only what it changed: Claude starts from the changed lines and the code around them, and reads further (a function a change calls, where a changed value ends up) only as far as it needs to. `scan-lines` here counts changed lines; the biggest changes go first, and anything past the limit is listed as not scanned. Use `scan-paths` and `scan-branches` to scan only the pushes you care about.

What it fixes arrives as a pull request (or, for a push to your own branch, a commit on it, like other fixes). What it can't fix is posted as a comment on the pushed commit, or, for a lap, as an issue, so you can talk it over with Claude there.

### Code quality

**Weekly passes** work through the codebase in batches of about `batch-lines` lines (1,500 by default):

1. The action lists the repository's source files (by `extensions`, inside `areas` if you set any, leaving out `exclude`d paths, lockfiles, minified, generated and vendored code) in a fixed order.
2. Each pass takes the next batch after the last file the previous pass covered, and wraps around to the start at the end. The hub remembers where each repository's pass stopped, so there's nothing to commit or configure.
3. Claude reads every file in its batch and may read any other file for context, but only changes the files in its batch. It makes no security fixes; anything it notices goes in the pull request description.
4. If the last code-quality pull request is still open, the week is skipped, so reviewed work is never overwritten.

A huge repository simply takes more weeks to get through. To go faster, raise `batch-lines`, or queue extra passes with `node scripts/hub.ts run owner/repo quality`.

**On pull requests and branches**, Claude looks at the source files that differ from the base (the pull request's base, or the default branch for a branch), up to `batch-lines`, using the diff to focus on the new code. A branch with an open pull request is treated as that pull request; a branch without one gets the commit pushed to it, or a pull request into it. With `pull-request-mode: commit` (the default) it pushes a commit to the pull request's branch and leaves one summary comment that it keeps up to date; with `pull-request-mode: pull-request` it opens a separate pull request into your branch instead. It only does this for:

- pull requests from branches in the same repository (never forks),
- opened by someone in `pull-request-authors` (by default, the repository owner), so collaborators' pull requests don't spend your usage,
- that aren't drafts or opened by bots, and whose latest commit isn't already Claude's.

It never force-pushes your branch: if you pushed while Claude was working, it stops and leaves your commits alone. It runs once when a pull request is opened, reopened or marked ready, not on every push.

### Conversations

Every one of Claude's pull requests, and every issue it has opened or commented on, is a conversation with it. Anywhere else, mention the app (`@<app slug>`, such as `@claude-code-scanning`) in an issue, a pull request, a comment or a review, and Claude joins that conversation; after that, it follows it without being mentioned again. There's nothing extra to store: each time, Claude reads the whole thread (the description, comments, reviews and inline review threads), with what arrived since its last reply marked as new. So a conversation lasts as long as the pull request or issue does, closed or not.

- **Anyone gets a reply.** Only maintainers (people with write access, or anyone in `pull-request-authors`) can get Claude to change code. Text from anyone else is treated as something to answer, never as instructions; a request for a change from them gets a reply saying a maintainer has to ask.
- **On Claude's open pull requests**, changes are pushed to its branch. Inline review comments get answers in their own threads, and Claude posts one comment summing up what it did.
- **On someone else's pull request** it was asked into, Claude pushes what a maintainer asks for to its branch, if the branch is in the same repository; on a fork's pull request it can only reply.
- **On issues**, Claude replies, and if a maintainer asks for a change, it updates its open pull request for that issue or opens a new one that refers to it.
- **Dismissing alerts:** a maintainer can tell Claude an alert is a false positive or not worth fixing (on a line the pull request changes, or by number or link, like "alert #244"), and Claude dismisses it on GitHub with a reason, listing it in its reply with a link to reopen it.
- **Starting work:** ask, say, "@claude-code-scanning run a security sweep" or "do a quality pass on this branch", and Claude queues it with the hub; it starts within minutes.
- **On closed or merged pull requests**, Claude still replies, but can't push; it says when something needs a new pull request.
- **Failed checks and new alerts** on Claude's open pull requests come back to it like comments: it reads the end of the failing job's log, or the alert, and pushes a fix.
- **Usage limits:** if Claude can't answer because your usage limit has been reached, it says so in the thread, with when it'll answer, and answers then without you commenting again. It keeps that to one note per thread.
- **It won't talk to itself forever.** Without a maintainer in between, Claude replies at most 3 times in a row, which covers a check it can't make pass and a stranger trying to run up your usage. Several comments left within a minute or two get one reply.

### Usage limits

When Claude reports a usage limit, the run stops without committing anything and tells the hub when the limit resets. The hub holds every repository's queued work until then, since they all spend the same subscription, and starts with the run that paused. If that run hits the limit again (a weekly limit, say), it pauses again with the new reset time.

Nothing sleeps in a job waiting for a limit, and Claude can't start subagents, so a run doesn't quietly multiply its usage.

## Security notes

- Claude only works on repositories the app is installed on and the hub permits. On pull requests and branches, it only changes same-repository ones by the people in `pull-request-authors`.
- In conversations, only maintainers can get Claude to change anything. Replies to anyone else run with read-only tools, and anything they changed would be thrown away.
- Anyone can open an issue on a public repository, so issue text reaches Claude as a description of a problem only, and everything still arrives as a pull request you review. Issues are only picked up if they carry one of `issue-labels`, and each is handled once, so a flood of unlabelled issues costs nothing.
- Claude gets file tools (read, edit, search) and Bash restricted to a handful of commands: your `verify-command` and read-only `git diff`/`git status`/`git log`. It can't start subagents, browse the web, or push.
- The action's inputs, tokens and runner credentials are removed from the environment Claude and your `verify-command` see. Claude can't read `.git/`, and the runner checks out with `persist-credentials: false` so no token is left in the checkout.
- Every request to the hub is signed: GitHub's webhooks with the webhook secret, your admin commands with an admin secret that never leaves your machine and the hub, and each run's reports with a key that only works for its own repository.
- The hub only hands credentials to a run whose GitHub OIDC token shows it's this repository's `run.yml`, started by `workflow_dispatch`, in a repository the hub permits. The GitHub token it hands out only covers that repository.
- Only branches in your own repository count as Claude's, so a fork can't pass off a branch named `claude/security/...` as an earlier triage.
- A repository's own `CLAUDE.md`, `.claude/settings.json` and `.github/claude-autofix.yml` steer Claude there, so whoever can change those can. That's normally only you. The settings file can't set credentials.
- Everything Claude does arrives as a pull request or a commit on your own pull request or branch. Nothing reaches your default branch without you.

## Troubleshooting

**Nothing happens on a repository**
Check `node scripts/hub.ts list`: the repository should be listed and permitted. If it isn't listed, check the app is installed on it and run `node scripts/hub.ts sync`. If the hub is paused, it's waiting for a usage limit to reset.

**"Dependabot alerts couldn't be read (HTTP 403)"**
Give the app the **Dependabot alerts** permission (read and write), then accept it on the installation.

**"Claude isn't enabled for this repository"**
The hub has no `CLAUDE_CODE_OAUTH_TOKEN`. Check the secret on this repository and run **Deploy hub**.

**"Dropped Claude's change to …"**
Claude edited a file outside its batch or an excluded path.

**"verify-command failed after Claude's changes"**
Nothing was pushed. The attempted diff is in the run log, in the repository's Actions tab.

**Deploy hub says "No access to the specified resource"**
The Cloudflare API token can't manage Workers on the account. The deploy's error lists the permissions it needs.

## Versioning

Releases follow semantic versioning. Each release is tagged `vMAJOR.MINOR.PATCH`, and the major tag (such as `v3`) moves to the newest release, so every repository's `@v3` gets fixes without breaking changes. The bundled Claude Code version follows `@anthropic-ai/claude-agent-sdk`, which Dependabot keeps current.

## License

MIT. See [LICENSE](LICENSE).
