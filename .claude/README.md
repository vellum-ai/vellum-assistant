# Claude Code Configuration

This directory contains Claude Code slash commands, helper scripts, and documentation for development workflows.

## Utility Scripts

### `worktree` — Git worktree management

Creates and removes isolated git worktrees for parallel development. Used by `/swarm`, `/do`, and `/blitz` commands.

```bash
.claude/worktree create feat/streaming
.claude/worktree remove feat/streaming --delete-branch
.claude/worktree list
```

### `scripts/vellum-runtime-tunnel.sh` — SSH tunnel for remote runtime access

Forwards a local TCP port to a remote Vellum runtime HTTP server via SSH. Use this when running the web app in local mode against a remote assistant daemon.

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

## Slash Commands

Slash commands for Claude Code that automate development workflows. They live in `.claude/commands/` (committed to the repo) and manage a shared task list (`.private/TODO.md`), create PRs, merge them, and track review status.

## Setup

### 1. Run `vel setup`

Create the required `.private/` tracking files manually. The `.private/` directory is gitignored, so every developer needs to set this up locally.

The slash commands themselves are committed at `.claude/commands/` and available automatically — no setup needed.

### 2. **IMPORTANT** Enable fast mode

Type `/fast` in your Claude Code session in order to toggle fast mode. Fast mode uses the same Opus model but with massively reduced latency and increased cost.
You should use this almost all the time for both running these scripts and adhoc work.
The only exception is `/check-reviews` since that's not a time-sensitive command.

## Commands

### `/brainstorm` - Generate task ideas

Explores the codebase and produces a prioritized list of improvements: features, bug fixes, refactors, security hardening, performance, testing, cleanup, etc. Presents the list for your approval before writing to `.private/TODO.md`.

**When to use:** When you want to fill up the backlog. Run it once, review the output, approve what you like.

**Frequency:** Occasionally, as needed.

```
/brainstorm                                             # generate a general task backlog for the entire project
/brainstorm focus on ideas relating to the desktop app  # generate a task backlog focused on the desktop app
```

### `/work` - Execute a single task

Picks the top item from `.private/TODO.md` (or a specific task if you pass an argument), implements it, creates a PR, merges it, and updates the tracking files.

**When to use:** The main workhorse. Run it whenever you want to knock out a task.

**Frequency:** As often as you want, but **one at a time**. Don't run multiple `/work` sessions in parallel -- they'll conflict on the same branch. Use `/swarm` for parallelism.

```
/work                            # picks the top TODO item
/work Fix the broken login flow  # works on a specific task
```

### `/swarm` - Parallel task execution

Spawns a pool of agents that work through `.private/TODO.md` in parallel using isolated git worktrees. Each agent picks a non-conflicting task, creates a PR, merges it, and reports back. The lead agent manages scheduling to avoid file conflicts.

**When to use:** When you have a backlog of independent tasks and want to burn through them fast.

**Frequency:** On demand. Can run for extended periods.

```
/swarm        # 12 parallel workers, runs until TODO.md is empty
/swarm 5      # 5 parallel workers
/swarm 12 10  # 12 workers, stop after 10 tasks completed
```

### `/check-reviews` - Process PR review feedback

Checks every PR in `.private/UNREVIEWED_PRS.md` for reviews from the automated reviewers (Codex and Devin bots). If reviewers requested changes, it adds "Address the feedback on \<PR>" tasks to the top of `.private/TODO.md`. Fully reviewed PRs are removed from the unreviewed list. PRs waiting 30+ minutes for a single reviewer are skipped (implicit approval).

**When to use:** Run periodically after merging PRs to see if reviewers flagged anything. The feedback tasks it creates are then picked up by `/work` or `/swarm`.

**Frequency:** Every 30-60 minutes while PRs are pending review, or whenever you want a status check.

```
/check-reviews
```

### `/check-reviews-and-swarm` - Check reviews then address feedback

Combines `/check-reviews` and `/swarm` into a single command. First triages all pending PR reviews, then immediately swarms on any feedback items that were added. Short-circuits if no feedback was found. Arguments are passed through to `/swarm`.

**When to use:** When you want to check for review feedback and address it all in one step, instead of running `/check-reviews` then `/swarm` separately.

**Frequency:** Every 30-60 minutes while PRs are pending review.

```
/check-reviews-and-swarm        # check reviews, then swarm with 12 workers
/check-reviews-and-swarm 5      # check reviews, then swarm with 5 workers
/check-reviews-and-swarm 12 10  # check reviews, then swarm with 12 workers, max 10 tasks
```

### `/mainline` - Ship current changes to main

Takes all uncommitted changes, creates a branch, commits, opens a PR, merges it via squash, adds the PR to the unreviewed list, and switches back to main. A one-shot command for shipping adhoc work. The PR body includes the original prompt (if provided) for traceability.

**When to use:** When you've been working on something interactively and want to ship it without manually going through the branch/PR/merge dance.

**Frequency:** Whenever you have uncommitted changes to ship.

```
/mainline                          # infers PR title from the changes
/mainline Fix login redirect bug   # uses the provided title
```

### `/do` - Implement and ship a one-off task

Takes a description of changes, creates an isolated git worktree, implements the changes, creates a PR, merges it, and cleans up the worktree. Like `/work` but for ad-hoc tasks that aren't in the backlog, and isolated in a worktree so it doesn't interfere with your working tree. The PR body includes the original prompt for traceability.

**When to use:** When you want to describe a change and have it implemented and shipped end-to-end without touching your current working directory.

**Frequency:** Whenever you have a self-contained task to ship.

```
/do Add input validation to the login form
/do Refactor the logger to use structured output
```

### `/execute-plan` - Execute a multi-PR rollout plan

Reads a plan file from `.private/plans/`, then sequentially implements and mainlines each PR described in the plan. Automatically detects which PRs have already been completed and picks up where it left off. The PR body includes the full plan content for traceability.

**When to use:** When you have a large feature broken into an ordered sequence of PRs (created manually or via brainstorming) and want to execute them one by one.

**Frequency:** Once per plan. Can be re-run to resume after interruption.

```
/execute-plan BROWSER_PLAN.md    # executes .private/plans/BROWSER_PLAN.md
/execute-plan AUTH_REFACTOR.md   # executes .private/plans/AUTH_REFACTOR.md
```

### `/safe-execute-plan` / `/safe-check-review` / `/resume-plan` - Human-in-the-loop plan execution

A three-command workflow for executing plans one PR at a time with human review between each step:

1. `/safe-execute-plan <file>` — implement the first PR and stop for review
2. `/safe-check-review [file]` — check for reviewer feedback, push fixes if needed, confirm ready to merge
3. `/resume-plan [file]` — merge the current PR, implement the next one, stop for review again

Multiple plans can run in parallel by specifying the plan name. Each plan PR body includes the full plan content for traceability.

### `/safe-blitz` - End-to-end feature execution on a feature branch

Like `/blitz` but creates a dedicated feature branch and opens a final PR into main for human review instead of merging automatically.

```
/safe-blitz Add WebSocket transport for daemon IPC
/safe-blitz --auto Refactor the logger
/safe-blitz --workers 5 --branch feature/dark-mode Add dark mode support
```

**Flags:** `--auto` (skip pauses), `--workers N` (parallel workers, default 12), `--skip-plan` (use existing "Ready" issues), `--branch NAME` (custom branch name)

### `/safe-blitz-done` - Finalize a safe-blitz

Squash-merges the feature branch PR into main, closes the project issue, and cleans up the local branch. Auto-detects the PR from the current branch, open `feature/*` PRs, or the project board.

### `/ship-and-merge` - Ship with automated review loop

Ships uncommitted changes via a PR, waits for Codex/Devin reviews, fixes valid feedback (up to 3 rounds), and squash-merges. The PR body includes the original prompt (if provided) for traceability.

### `/plan-html` - Create or refresh a plan with HTML view

Creates or refreshes a rollout plan in `.private/plans/` with both markdown and a polished HTML review view (per-PR file lists, dependency diagram).

### `/release` - Cut a release

Pulls main, determines/creates a version tag, generates release notes from commits, publishes a GitHub Release, and confirms CI was triggered.

```
/release        # auto-increments patch version
/release v1.2.0 # specific version
```

### `/blitz` - End-to-end feature execution

Plans a feature from scratch, creates a GitHub project board and milestone issues, swarm-executes them in parallel, sweeps for review feedback, addresses it, and reports a final summary. Combines `/brainstorm` + `/swarm` + `/check-reviews` into a single end-to-end workflow.

The project board is created under the `vellum-ai` org with the naming convention `<github-username>-<repo-name>`. Milestone issues are added to the board and tracked through Ready → In Progress → In Review → Done.

**When to use:** When you have a feature to build end-to-end and want the full plan → execute → review → fix cycle handled automatically.

**Frequency:** Once per feature. The command manages the entire lifecycle.

```
/blitz Add WebSocket transport for daemon IPC    # plan + execute a feature
/blitz --auto Refactor the logger                # skip pause between rounds
/blitz --workers 5 Add dark mode support         # use 5 parallel workers
/blitz --skip-plan                               # skip planning, use existing "Ready" issues on the board
```

**Flags:**
- `--auto` — skip the pause between swarm and sweep phases (default: pause and ask)
- `--workers N` — number of parallel swarm workers (default: 12)
- `--skip-plan` — skip issue creation; use issues already in the "Ready" column of the project board

## Typical workflow

3 shells with Claude Code open, one for each of work/swarm, check-reviews, and brainstorm.

### Work / Swarm

This is the main workflow.

```
/work
/work
/work
...
```

```
/work Address the feedback on https://github.com/vellum-ai/vellum-assistant/pull/999
...
```

```
/swarm 4 20 # run 4 workers, stop after 20 tasks
...
```

```
/swarm 4 # run 4 workers, never give up, never surrender
...
```

### Check-reviews

Run this periodically to make sure you're not missing any feedback on merged PRs.

```
/check-reviews
...
```

Or use `/check-reviews-and-swarm` to check and address feedback in one step:

```
/check-reviews-and-swarm
...
```

### Brainstorm

```
/brainstorm              # generate and approve a task backlog
```

```
/brainstorm focus on ideas relating to the desktop app
```

## Using with other coding agents

These commands are designed for Claude Code, but you can use them in other coding agents by telling them to follow the instructions in the corresponding script.
The swarm command specifically relies on Claude Code's Agent Teams, so you might not be able to use it in other agents.

### Work prompt

```
Follow the instructions in .claude/commands/work.md
```

### Check-reviews prompt

```
Follow the instructions in .claude/commands/check-reviews.md
```

### Check-reviews-and-swarm prompt

```
Follow the instructions in .claude/commands/check-reviews-and-swarm.md
```

### Brainstorm prompt

```
Follow the instructions in .claude/commands/brainstorm.md
```

### Mainline prompt

```
Follow the instructions in .claude/commands/mainline.md
```

### Do prompt

```
Follow the instructions in .claude/commands/do.md
```

### Execute-plan prompt

```
Follow the instructions in .claude/commands/execute-plan.md
```

### Blitz prompt

```
Follow the instructions in .claude/commands/blitz.md <feature description>
```
