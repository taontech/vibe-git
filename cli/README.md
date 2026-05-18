# GMC

> A local Git workbench for AI-assisted development. Start with `gmc web`: a browser dashboard for Git state, repository tasks, changes, commit history, and AI-generated commit messages.

![GMC Web dashboard](../docs/assets/gmc-web-dashboard2.png)

## Install

```sh
npm install -g gmc
gmc --version
```

## Start With Web

```sh
cd path/to/your/repo
gmc web
```

`gmc web` starts a local server for the current repository and opens a visual Git dashboard.

| Web surface | Why it helps |
| --- | --- |
| Branch, upstream, ahead/behind state | Decide whether to push, pull, or keep working before committing. |
| Selectable working tree files | Commit only the files you intend to include. |
| Branch tree and commit graph | See where current work sits in repository history. |
| Clickable commit details | Inspect the full message and file summary without leaving the page. |
| Repository task board | Keep lightweight Markdown tasks in `.gmc/tasks` with the code. |
| Background task status | Track AI commit-message rewrites from the same dashboard. |

## Daily Commit Loop

```sh
gmc install --all
git add .
git commit -m gmc
```

When the commit message is exactly `gmc`, the commit returns immediately. GMC records the new commit, generates a better commit message in the background, and rewrites that commit only if it is still `HEAD`.

Check background work:

```sh
gmc status
gmc retry HEAD
```

## Commands

| Command | Status | Purpose |
| --- | --- | --- |
| `gmc --version` | Ready | Print the installed CLI version. |
| `gmc web [--port 4277] [--no-open]` | Ready | Start or open the local GitWeb dashboard. |
| `gmc install --all [--port 4277]` | Ready | Install hooks and create the local Web link. |
| `gmc install-hooks` | Ready | Install only the non-blocking commit-message hooks. |
| `gmc status` | Ready | Show current repository status and recent background work. |
| `gmc message` | Ready | Generate a commit message from staged changes. |
| `gmc commit [--no-edit]` | Ready | Generate a message and commit staged changes. |
| `gmc retry [commit]` | Ready | Queue another background message attempt. |

## Requirements

- Git repository
- Node.js 18 or newer
- `codex` CLI for AI commit-message generation
- Optional: `claude` CLI for future agent workflows

## Safety

- GMC Web serves `127.0.0.1` only.
- Credentials are read from environment variables and are not written to the repository.
- Repository tasks are ordinary Markdown files under `.gmc/tasks`.
- Background commit-message rewrites only target the recorded commit while it is still `HEAD`.
- Automatic rewrites are skipped during merge/rebase-style operations and for signed commits.
