# GitManager / gmc

This repository started as a macOS task manager that connected Git commits to
GitHub issues. The current direction is a modern CLI-first workflow for AI
coding:

```text
GitHub Issue -> AI coding session -> branch binding -> commit message with Issue trailer
```

The active implementation lives in [`cli`](./cli).

## CLI MVP

Start an AI coding session from an issue:

```sh
gmc GH-234 --agent codex
gmc GH-234 --agent claude
```

Set or inspect the default agent:

```sh
gmc agent claude
gmc agent
```

Bind the current branch to an issue without starting an agent:

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

When the commit message is exactly `gmc`, the commit completes immediately.
`gmc` then runs Codex in the background and rewrites the new HEAD commit's
message after generation finishes. If another commit is created first, the
background task skips the rewrite instead of changing older history.

Use `gmc status` to inspect recent background message jobs. It shows whether a
job is waiting, running, stale, failed, skipped, or completed, plus the
`.git/gmc/logs` path to the captured worker log.
If a previous worker leaves a stale rewrite lock behind, the next worker
recovers the lock before generating the latest HEAD message.
Run `gmc retry` to queue a new background attempt for the current `HEAD`.

When the current branch has an issue binding, generated commit messages include:

```text
Issue: GH-234
```

## Authentication

For GitHub API access, provide one of:

```sh
export GITHUB_TOKEN=...
export GH_TOKEN=...
```

If Codex inherits an incompatible model from your user config, set:

```sh
export GMC_CODEX_MODEL=gpt-5-codex
```

Background commit-message generation times out after 10 minutes by default:

```sh
export GMC_CODEX_TIMEOUT_MS=600000
```

Do not store tokens in the repository.
