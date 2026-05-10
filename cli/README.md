# gmc CLI

`gmc` is the command-line entry point for GMC Web and AI-assisted Git commits.

- Full English README: [../README.md](../README.md)
- 简体中文 README: [../README.zh-CN.md](../README.zh-CN.md)

## Start With Web

Install from this repository:

```sh
# from the repository root
npm install -g ./cli

# or from this cli directory
npm install -g .
```

```sh
gmc web
```

The Web UI starts a local dashboard for the current repository: branch state, working tree files, branch tree, commit graph, commit details, and background GMC task status.

## Daily Commit Loop

```sh
gmc install --all
git add .
git commit -m gmc
```

When the commit message is exactly `gmc`, the commit returns immediately. GMC generates a better commit message in the background and rewrites the new `HEAD` only if it is still safe to do so.

## Useful Commands

| Command | Purpose |
| --- | --- |
| `gmc web [--port 4277] [--no-open]` | Start or open the local GitWeb dashboard. |
| `gmc install --all [--port 4277]` | Install hooks and create the local Web link. |
| `gmc status` | Inspect repository state and background tasks. |
| `gmc message` | Generate a commit message from staged changes. |
| `gmc commit [--no-edit]` | Generate a message and commit staged changes. |
| `gmc retry [commit]` | Queue another background message attempt. |

Issue-centered commands such as `gmc <issue>` and `gmc bind <issue>` are still experimental. They are being redesigned around GMC Web and should not be treated as the primary workflow yet.
