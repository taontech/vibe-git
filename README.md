# GMC

> A local Git workbench for AI-assisted development. Start with `gmc web`: a visual dashboard for Git state, repository tasks, changes, commit history, and AI-generated commit messages.

[简体中文](./README.zh-CN.md) | English

![GMC Web dashboard](./docs/assets/gmc-web-dashboard2.png)

## Why GMC Web

`gmc web` turns the current Git repository into a local browser dashboard. It keeps the terminal-friendly workflow, but gives you a fast visual surface for the work that is easiest to misread in plain CLI output.

| What you see | Why it helps |
| --- | --- |
| Current branch, upstream, ahead/behind counts | Know whether you should push, pull, or keep working before you commit. |
| Working tree with selectable files | Commit the intended files without staging unrelated changes by accident. |
| Branch tree and recent commit graph | Understand where the current work sits in repository history. |
| Clickable commit details | Inspect a full commit message and file summary without leaving the page. |
| Repository task board | Keep lightweight tasks in `.gmc/tasks`, so tasks travel with the code. |
| Background GMC task status | Track AI commit-message rewrites from the same place you review the repo. |

```mermaid
flowchart LR
  A["Open a repository"] --> B["gmc web"]
  B --> C["Review branch and upstream state"]
  B --> D["Select changed files"]
  D --> E["Commit with gmc hooks"]
  E --> F["AI-generated commit message"]
  B --> G["Inspect commits and branch graph"]
  B --> H["Manage repo tasks"]
```

## Quick Start

Install from npm:

```sh
npm install -g gmc
gmc --version
```

Then open any Git repository:

```sh
cd path/to/your/repo
gmc web
```

`gmc web` starts a local server for the current repository and opens the dashboard. If a GMC Web server is already running, the command opens the existing server with the current repository selected.

Use a custom port when needed:

```sh
gmc web --port 4277
GMC_GITWEB_PORT=4277 gmc web
```

## Install The Full Local Workflow

```sh
gmc install --all
```

This installs GMC commit hooks and writes a repository-specific `git.webloc` link on macOS. After that, the short commit loop is:

```sh
git add .
git commit -m gmc
```

When the commit message is exactly `gmc`, the commit returns immediately. GMC records the new commit, starts AI message generation in the background, and rewrites that commit only if it is still `HEAD`. If the branch moves first, the task is skipped instead of changing older history.

Check background work:

```sh
gmc status
gmc retry HEAD
```

## Web Features

### Repository Overview

The first screen shows the current branch, upstream tracking, ahead/behind counts, changed file count, and recent contribution activity. This is the state you usually need before deciding whether to pull, push, commit, or pause.

### Visual Working Tree

Select changed files directly in the browser, then commit only those files. Untracked files can be ignored from the same panel, and selected changes can be restored when you intentionally want to discard them.

### Commit Graph

The commit graph combines recent history with branch coloring, author/date metadata, and clickable commit details. It gives a compact visual check before pushing work or reviewing a generated commit message.

### Repository Task Board

GMC Web includes a lightweight task board with Todo, Doing, Review, and Done lanes. Tasks are stored as Markdown files under `.gmc/tasks`, so they can be committed, reviewed, pushed, and pulled with the repository.

Each task keeps a simple title and Markdown content. The board shows compact cards for scanning, while the task detail dialog renders the full Markdown and lets you edit it.

When you commit through `gmc commit`, GMC Web, or `git commit -m gmc`, GMC asks the configured AI agent to compare the staged diff with the current task list. Related tasks are moved forward to `doing`, `review`, or `done`, and the changed task Markdown files are staged into the same commit.

### AI Commit Messages

GMC can generate commit messages from staged diffs:

```sh
git add .
gmc message
```

Or generate, edit, and commit:

```sh
git add .
gmc commit
```

The hook-based path is the fastest daily workflow:

```sh
git commit -m gmc
```

## Requirements

- Git repository
- Node.js 18 or newer
- `codex` CLI for AI commit-message generation
- Optional: `claude` CLI when `gmc agent claude` is configured

If Codex inherits an incompatible model from your user config, set:

```sh
export GMC_CODEX_MODEL=gpt-5-codex
```

Background commit-message generation times out after 10 minutes by default:

```sh
export GMC_CODEX_TIMEOUT_MS=600000
```

## Commands

| Command | Status | Purpose |
| --- | --- | --- |
| `gmc --version` | Ready | Print the installed CLI version. |
| `gmc web [--port 4277] [--no-open]` | Ready | Start or open the local GitWeb dashboard. |
| `gmc install --all [--port 4277]` | Ready | Install hooks and create the local Web link. |
| `gmc install-hooks` | Ready | Install commit-message and task-status hooks. |
| `gmc status` | Ready | Show current repository status and recent background work. |
| `gmc message` | Ready | Generate a commit message from staged changes. |
| `gmc commit [--no-edit]` | Ready | Generate a message, update related task statuses, and commit staged changes. |
| `gmc retry [commit]` | Ready | Queue another background message attempt. |

## Safety Model

- GMC Web serves `127.0.0.1` only.
- Credentials are read from environment variables and are not written to the repository.
- Repository tasks are ordinary Markdown files under `.gmc/tasks`.
- Background commit-message rewrites only target the recorded commit while it is still `HEAD`.
- Automatic rewrites are skipped during merge/rebase-style operations and for signed commits.
