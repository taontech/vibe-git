# gmc

`gmc` binds GitHub issues to AI coding sessions and commit messages.

The first MVP focuses on one loop:

```text
GitHub Issue -> AI coding session -> branch binding -> commit message with Issue trailer
```

## Requirements

- Git repository with a GitHub `origin` remote
- `codex` or `claude` CLI installed
- `GITHUB_TOKEN` or `GH_TOKEN` for private repositories or higher API limits
- `GMC_CODEX_MODEL` optionally overrides the Codex model used for commit
  message generation

## Commands

Start an AI coding session from an issue:

```sh
gmc GH-234 --agent codex
gmc GH-234 --agent claude
```

Set the default agent for your user:

```sh
gmc agent codex
gmc agent claude
gmc agent
```

The default is stored in `~/.config/gmc/config.json` and shared by every
repository.

This fetches the issue, creates or switches to a branch like
`codex/GH-234-short-title`, stores the issue binding locally, and starts the
selected agent with a structured prompt.

Bind the current branch without starting an agent:

```sh
gmc bind GH-234
```

Show the current binding:

```sh
gmc status
```

Generate a commit message from staged changes:

```sh
git add .
gmc message
```

Generate, edit, and commit:

```sh
git add .
gmc commit
```

Install non-blocking commit-message hooks:

```sh
gmc install-hooks
git commit -m gmc
```

When the commit message is exactly `gmc`, the commit returns immediately.
`gmc` records the new commit, runs Codex in the background, and rewrites that
commit's message only if it is still `HEAD`. If the branch moves first, the
task is marked skipped under `.git/gmc/tasks`.
The post-commit hook prints `GMC >>>` terminal lines when the background
generation starts, including the target commit and task log path.
Use `gmc status` to inspect recent background jobs. It reports running, failed,
waiting, skipped, stale, and completed jobs, with the captured worker log path.
If a previous worker leaves a stale rewrite lock behind, the next worker
recovers the lock before generating the latest HEAD message.
Run `gmc retry` to queue a new background attempt for the current `HEAD`.


open the local GitWeb dashboard:

```sh
gmc web
```
`gmc web` starts a local server for the current repository, opens the page,
and provides live JSON endpoints from the running `gmc` process. The first
screen shows branch/upstream state, working tree changes, branch activity, issue
binding context, background tasks, and recent commits. Click a commit to inspect
its full commit message and file summary.

The generated message includes:

```text
Issue: GH-234
```

If Codex inherits an incompatible model from your user config, set:

```sh
export GMC_CODEX_MODEL=gpt-5-codex
```

Background commit-message generation times out after 10 minutes by default:

```sh
export GMC_CODEX_TIMEOUT_MS=600000
```

## Safety

`gmc` stores issue bindings in local Git config and `.git/gmc/current.json`.
It does not write credentials to the repository. Use environment variables for
GitHub authentication. `gmc commit` validates the generated message before
committing and aborts if Codex returns logs or an error transcript.
The non-blocking hook also skips automatic rewrites during merge/rebase style
operations and for signed commits.
