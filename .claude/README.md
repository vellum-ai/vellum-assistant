# Claude Code Configuration

This directory contains Claude Code slash commands, helper scripts, and documentation for development workflows.

## Shared Commands (claude-skills)

Most commands, phases, and scripts are shared from the [`claude-skills`](https://github.com/vellum-ai/claude-skills) repo via symlinks. After cloning this repo, run:

```bash
path/to/claude-skills/setup
```

This creates symlinks for 18 commands, 7 phase files, and 6 utility scripts. See the [claude-skills README](https://github.com/vellum-ai/claude-skills) for the full command reference.

Re-run `setup` after pulling updates to the claude-skills repo.

### Repo-local commands

These commands are specific to vellum-assistant and live in `.claude/skills/<name>/` as local skill directories (NOT symlinks):

- **`/update`** — Pull latest from main, use `vellum ps/sleep/wake` to manage assistant/gateway lifecycle, rebuild/launch the macOS app (`.claude/skills/update/SKILL.md`)
- **`/release`** — Cut a new release by triggering the GitHub Actions release workflow (`.claude/skills/release/SKILL.md`)
- **`/triage`** — Search Sentry for recent errors and log reports by user, assistant, or device, then cross-reference with Linear issues for a triage summary (`.claude/skills/triage/SKILL.md`)

The shared-vs-local model:
- **Shared commands**: maintained in the `claude-skills` repo, symlinked by `setup` to `.claude/skills/<name>` and `.claude/commands/<name>.md`
- **Local commands**: maintained directly in `.claude/skills/<name>/SKILL.md` — these are NOT symlinks and are tracked in this repo's git. The `setup` script preserves local skill directories (it detects non-symlink directories with real files and skips them).

## Utility Scripts

### `worktree` — Git worktree management (shared)

Creates and removes isolated git worktrees for parallel development. Used by `/swarm`, `/do`, and `/blitz` commands.

```bash
.claude/worktree create feat/streaming
.claude/worktree remove feat/streaming --delete-branch
.claude/worktree list
```

### `scripts/vellum-runtime-tunnel.sh` — SSH tunnel for remote runtime access

Forwards a local TCP port to a remote Vellum runtime HTTP server via SSH. Use this when running the web app in local mode against a remote assistant.

```bash
# Start a tunnel to a remote host
scripts/vellum-runtime-tunnel.sh start user@remote-host

# Check tunnel status
scripts/vellum-runtime-tunnel.sh status

# Print env vars for web local mode
scripts/vellum-runtime-tunnel.sh print-env

# Stop the tunnel
scripts/vellum-runtime-tunnel.sh stop
```

Options: `--local-port PORT` and `--remote-port PORT` (both default to 7821).

## Setup

### 1. Run setup

```bash
# Clone claude-skills alongside this repo (if not already done)
git clone git@github.com:vellum-ai/claude-skills.git

# Create symlinks
path/to/claude-skills/setup
```

The `.private/` directory (for `TODO.md`, `UNREVIEWED_PRS.md`) is created automatically by the setup script.

### 2. **IMPORTANT** Enable fast mode

Type `/fast` in your Claude Code session in order to toggle fast mode. Fast mode uses the same Opus model but with massively reduced latency and increased cost.
You should use this almost all the time for both running these scripts and adhoc work.
The only exception is `/check-reviews` since that's not a time-sensitive command.

## Typical workflow

3 shells with Claude Code open, one for each of work/swarm, check-reviews, and brainstorm.

### Work / Swarm

```
/work
/work Fix the broken login flow
/swarm 4 20
```

### Check-reviews

```
/check-reviews
/check-reviews-and-swarm
```

### Brainstorm

```
/brainstorm
/brainstorm focus on ideas relating to the desktop app
```

## Using with other coding agents

These commands are designed for Claude Code, but you can use them in other coding agents by telling them to follow the instructions in the corresponding command file (e.g., `Follow the instructions in .claude/commands/work.md`).

The swarm command specifically relies on Claude Code's Agent Teams, so you might not be able to use it in other agents.
