# GMC — Agent Guide

## What this is

`gmc` (Global Machine/sistant Commit) — Node.js CLI + web dashboard for Git repos with AI-generated commit messages. Published on npm as `gmc`.

## Project structure

```
cli/              # npm package (single package, not a monorepo)
  bin/gmc.js      # Entrypoint
  lib/            # Modules (web.js, agent.js, git.js, autogmc.js, etc.)
  test/test.js    # Stub — not real tests
.gmc/tasks/       # Project-level markdown tasks
```

## Commands

| Action | Command |
|--------|---------|
| syntax-check all JS | `npm test` (runs `node --check` on each `.js` in lib/) |
| run CLI | `npm start` or `node bin/gmc.js` |
| dev mode (auto-restart on web.js change) | `gmc web --watch` |

## Codebase conventions

- **CommonJS** throughout (`var`, `require`, `module.exports`) — no ES modules, no TypeScript
- **ES5 style** — no arrow functions, no `const`/`let`, no template literals in existing code
- No bundler, no build step
- Web UI is inline HTML strings in `cli/lib/web.js` (no framework)
- HTTP server is raw `node:http`

## Key env vars

| Var | Purpose |
|-----|---------|
| `GMC_CODEX_MODEL` | Override AI model for commit messages |
| `GMC_CODEX_TIMEOUT_MS` | Generation timeout (default 600000 / 10 min) |
| `GMC_GITWEB_PORT` | Web dashboard port (default 4277) |
| `GITHUB_TOKEN` / `GH_TOKEN` | GitHub API auth |

## Architecture notes

- State lives in `.git/gmc/` (per-repo, uncommitted) and `~/.config/gmc/` (global)
- Auth token at `~/.config/gmc/gitweb-token` (auto-generated, 64 hex chars)
- Web server binds `0.0.0.0` but blocks non-localhost by default; toggle via `~/.config/gmc/gitweb-security.json`
- Background commit-message generation triggered by `git commit -m gmc` hooks
- Hooks only rewrite if commit is still HEAD; skipped during merge/rebase or for signed commits
- Commit subject enforced to ≤72 chars
- Tasks stored as `.gmc/tasks/GMC-*.md` with YAML frontmatter

## Daily workflow

```sh
gmc install --all     # one-time: installs hooks + macOS .webloc
git add .
git commit -m gmc     # returns immediately; AI rewrites in background
gmc status            # check background task status
gmc retry HEAD        # retry failed message generation
```

## Testing

Only `npm test` exists — syntax validation via `node --check`. No unit/integration tests.

## CI

GitHub Actions on release only: `npm ci && npm test && npm publish` to GitHub Packages.
