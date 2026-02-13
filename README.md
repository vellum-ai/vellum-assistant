# Vellum Assistant

AI-powered assistant platform by Vellum.

## Architecture

The platform has three main components:

- **Assistant runtime** (`assistant/`): Bun + TypeScript daemon that owns conversation history, attachment storage, and channel delivery state in a local SQLite database. Exposes an HTTP API consumed by the web app and gateway.
- **Web app** (`web/`): Next.js frontend and API layer. Stores assistant metadata, auth, and channel config in Postgres. All chat operations proxy through the assistant runtime via a unified `RuntimeClient`.
- **Gateway** (`gateway/`): Standalone Bun + TypeScript service that owns Telegram integration end-to-end. Receives Telegram webhooks, routes to the correct assistant via static settings, forwards to the assistant runtime, and sends replies back to Telegram.

## Repository Structure

```
/
├── web/               # Next.js web application
├── assistant/         # Bun-based assistant runtime
├── clients/           # Desktop clients
├── gateway/           # Telegram gateway service
├── sanity-content/    # Sanity content
├── scripts/           # Utility scripts
└── .github/           # GitHub Actions workflows
```

## Local Development

```bash
# Start local services (Postgres + MinIO)
docker compose up -d

# Start the web app
cd web
bun run dev
```

## Git Hooks

This repository includes git hooks to help maintain code quality and security. The hooks are installed by running the install script directly.

To manually install or update hooks:
```bash
./.githooks/install.sh
```

See [.githooks/README.md](./.githooks/README.md) for more details about available hooks.

## Web Application

The web app lives in `/web`. See [web/README.md](./web/README.md) for setup instructions.

```bash
cd web
npm install
npm run dev
```

## Assistant Runtime

The assistant runtime lives in `/assistant`. See [assistant/README.md](./assistant/README.md) for details.

```bash
cd assistant
bun install
bun run src/index.ts daemon start
```

## Remote Access

Access a remote assistant daemon from your local machine via SSH.

### Web (runtime HTTP tunnel)

The web app connects to the runtime via HTTP. Use the tunnel helper to forward the runtime port:

```bash
# On your local machine — forward remote runtime port
scripts/vellum-runtime-tunnel.sh start user@remote-host

# Print env vars for web local mode
scripts/vellum-runtime-tunnel.sh print-env
# Output:
#   ASSISTANT_CONNECTION_MODE=local
#   LOCAL_RUNTIME_URL=http://127.0.0.1:7821

# On the remote host, start the daemon with HTTP enabled
RUNTIME_HTTP_PORT=7821 bun run src/index.ts daemon start
```

### CLI (socket forwarding)

The CLI connects via Unix socket. Forward the socket with SSH:

```bash
ssh -L ~/.vellum/remote.sock:/home/user/.vellum/vellum.sock user@remote-host -N &
VELLUM_DAEMON_SOCKET=~/.vellum/remote.sock vellum
```

When `VELLUM_DAEMON_SOCKET` is set, autostart is disabled by default. Set `VELLUM_DAEMON_AUTOSTART=1` to override.

### macOS app (socket forwarding)

The macOS app also supports `VELLUM_DAEMON_SOCKET`. Launch it from the terminal:

```bash
ssh -L ~/.vellum/remote.sock:/home/user/.vellum/vellum.sock user@remote-host -N &
VELLUM_DAEMON_SOCKET=~/.vellum/remote.sock open -a Vellum
```

### Troubleshooting

| Symptom | Check |
|---|---|
| Web: "Failed to connect to runtime" | Is the tunnel running? (`scripts/vellum-runtime-tunnel.sh status`) |
| Web: "CLOUD_RUNTIME_URL must be set" | Set `ASSISTANT_CONNECTION_MODE=local` |
| CLI: "could not connect to daemon socket" | Is the SSH socket tunnel active? Check `VELLUM_DAEMON_SOCKET` path |
| CLI: daemon starts locally despite socket override | Check that `VELLUM_DAEMON_AUTOSTART` is not set to `1` |
| macOS: not connecting | Verify socket path in `VELLUM_DAEMON_SOCKET` exists and is writable |
| Any: "connection refused" | Is the remote daemon running? (`vellum daemon status` on remote) |

Run `vellum doctor` for a full diagnostic check including socket path and autostart policy.

## Claude Code Workflow

This repo includes Claude Code slash commands (in `.claude/commands/`) for agent-driven development.

### Single-task commands

| Command | Purpose |
|---------|---------|
| `/do <description>` | Implement a change in an isolated worktree, create a PR, squash-merge it to main, and clean up. |
| `/mainline` | Ship uncommitted changes already in your working tree to main via a squash-merged PR. |
| `/work` | Pick up the next task from `.private/TODO.md` (or a task you specify), implement it, PR it, and merge it. |

### Multi-task / parallel commands

| Command | Purpose |
|---------|---------|
| `/brainstorm` | Deep-read the codebase, generate a prioritized list of improvements, and update `.private/TODO.md` after approval. |
| `/swarm [workers] [max-tasks]` | Parallel execution — spawns a pool of agents (default 12) that work through `.private/TODO.md` concurrently, each in its own worktree. PRs are auto-assigned to the current user. |
| `/blitz <feature>` | End-to-end feature delivery — plans the feature, creates GitHub issues on a project board, swarm-executes them in parallel, sweeps for review feedback, addresses it, and reports. Merges directly to main. |
| `/safe-blitz <feature>` | End-to-end feature delivery on a feature branch — plans, creates issues, swarm-executes in parallel, sweeps for review feedback. All milestone PRs merge into a feature branch (not main). Creates a final PR for manual review. Does not switch your working tree. Supports `--auto`, `--workers N`, `--skip-plan`, `--branch NAME`. |
| `/safe-blitz-done [PR\|branch]` | Finalize a safe-blitz — squash-merges the feature branch PR into main, sets the project issue to Done, closes the issue, and deletes the local branch. Auto-detects the PR from current branch, open `feature/*` PRs, or project board "In Review" items. |
| `/execute-plan <file>` | Sequential multi-PR rollout — reads a plan file from `.private/plans/`, executes each PR in order, mainlining each before moving to the next. |

### Human-in-the-loop plan execution

A three-command workflow for executing plans one PR at a time with human review between each step. Each plan gets its own state file in `.private/safe-plan-state/`, so multiple plans can run concurrently in separate sessions.

| Command | Purpose |
|---------|---------|
| `/safe-execute-plan <file>` | Start a plan from `.private/plans/` — implements the first PR, creates it (without merging), and stops to wait for review. |
| `/safe-check-review [file]` | Check the active plan PR for feedback from codex/devin/humans. Addresses requested changes by pushing fixes. Waits if reviews are still pending — only recommends merging once all reviewers have responded. Auto-detects the plan if only one is active. |
| `/resume-plan [file]` | Merge the current PR, implement the next one, create it, and stop again. Repeats until the plan is complete. Auto-detects the plan if only one is active. |

**Typical flow:**

1. **`/safe-execute-plan MY_PLAN.md`** — starts the plan, creates PR 1, stops
2. **`/safe-check-review MY_PLAN.md`** — run periodically; waits for pending reviews, addresses feedback, or gives the all-clear to merge
3. **`/resume-plan MY_PLAN.md`** — merge PR 1, create PR 2, stop (only after `/safe-check-review` confirms all reviews are in)
4. Repeat steps 2–3 until the plan is complete

Multiple plans can run in parallel — just specify the plan name to disambiguate.

### Utility

| Command | Purpose |
|---------|---------|
| `/scrub` | Kill the running Vellum app (non-fatal if not running), wipe all persistent data, and relaunch the daemon and macOS app for a clean first-run experience. |

### Review

| Command | Purpose |
|---------|---------|
| `/check-reviews` | Checks for review feedback on unreviewed PRs and creates follow-up tasks. |

### Typical flow

1. **`/brainstorm`** — generate ideas, approve them into `TODO.md`
2. **`/swarm`** — burn through the TODO list in parallel
3. **`/check-reviews`** — sweep for reviewer feedback
4. **`/swarm`** again — address the feedback

Or for a focused feature: **`/blitz <feature>`** handles all of the above in one shot (plan, issues, swarm, sweep, report). Use **`/safe-blitz <feature>`** for the same workflow but with a feature branch and a final PR for manual review, then **`/safe-blitz-done`** to merge it when ready.

For controlled, sequential plan execution with human review at every step: **`/safe-execute-plan <file>`** → **`/safe-check-review`** → **`/resume-plan`** → repeat.

All workflows use squash-merge (no merge commits), worktree isolation for parallel work, and track state in `.private/TODO.md`, `.private/DONE.md`, and `.private/UNREVIEWED_PRS.md`.

## License

Proprietary - Vellum AI
