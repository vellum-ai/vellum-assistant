# Scripts

This directory contains automation commands for Claude Code and helper scripts for development workflows.

## Utility Scripts

### `vellum-runtime-tunnel.sh` — SSH tunnel for remote runtime access

Forwards a local TCP port to a remote Vellum runtime HTTP server via SSH. Use this when running the web app in local mode against a remote assistant daemon.

```bash
# Start a tunnel to a remote host
scripts/vellum-runtime-tunnel.sh start user@remote-host

# Check tunnel status
scripts/vellum-runtime-tunnel.sh status

# Print env vars for web local mode
scripts/vellum-runtime-tunnel.sh print-env
# Output:
#   ASSISTANT_CONNECTION_MODE=local
#   LOCAL_RUNTIME_URL=http://127.0.0.1:7821

# Stop the tunnel
scripts/vellum-runtime-tunnel.sh stop
```

Options: `--local-port PORT` and `--remote-port PORT` (both default to 7821).

## Automation Commands

Slash commands for Claude Code that automate development workflows. They manage a shared task list (`.private/TODO.md`), create PRs, merge them, and track review status.

## Setup

### 1. Symlink into Claude Code

Claude Code loads custom slash commands from `.claude/commands/` in the project root. Symlink each file:

```bash
mkdir -p .claude/commands
cd .claude/commands
ln -s ../../scripts/commands/work.md work.md
ln -s ../../scripts/commands/check-reviews.md check-reviews.md
ln -s ../../scripts/commands/brainstorm.md brainstorm.md
ln -s ../../scripts/commands/swarm.md swarm.md
ln -s ../../scripts/commands/mainline.md mainline.md
ln -s ../../scripts/commands/do.md do.md
ln -s ../../scripts/commands/execute-plan.md execute-plan.md
ln -s ../../scripts/commands/blitz.md blitz.md
```

After symlinking, the commands are available as `/work`, `/check-reviews`, `/brainstorm`, `/swarm`, `/mainline`, `/do`, `/blitz`, and `/execute-plan` in Claude Code.

### 2. **IMPORTANT** Enable fast mode

Type `/fast` in your Claude Code session in order to toggle fast mode. Fast mode uses the same Opus model but with massively reduced latency and increased cost.
You should use this almost all the time for both running these scripts and adhoc work.
The only exception is `/check-reviews` since that's not a time-sensitive command.

### 3. Required files

Create the tracking files if they don't exist:

```bash
mkdir -p .private
touch .private/TODO.md .private/DONE.md .private/UNREVIEWED_PRS.md
```

These are gitignored. Multiple commands read and write to them concurrently, so the commands are careful to read before writing and verify after.

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
/swarm       # 3 parallel workers, runs until TODO.md is empty
/swarm 5     # 5 parallel workers
/swarm 3 10  # 3 workers, stop after 10 tasks completed
```

### `/check-reviews` - Process PR review feedback

Checks every PR in `.private/UNREVIEWED_PRS.md` for reviews from the automated reviewers (Codex and Devin bots). If reviewers requested changes, it adds "Address the feedback on \<PR>" tasks to the top of `.private/TODO.md`. Fully reviewed PRs are removed from the unreviewed list. PRs waiting 30+ minutes for a single reviewer are skipped (implicit approval).

**When to use:** Run periodically after merging PRs to see if reviewers flagged anything. The feedback tasks it creates are then picked up by `/work` or `/swarm`.

**Frequency:** Every 30-60 minutes while PRs are pending review, or whenever you want a status check.

```
/check-reviews
```

### `/mainline` - Ship current changes to main

Takes all uncommitted changes, creates a branch, commits, opens a PR, merges it via squash, adds the PR to the unreviewed list, and switches back to main. A one-shot command for shipping adhoc work.

**When to use:** When you've been working on something interactively and want to ship it without manually going through the branch/PR/merge dance.

**Frequency:** Whenever you have uncommitted changes to ship.

```
/mainline                          # infers PR title from the changes
/mainline Fix login redirect bug   # uses the provided title
```

### `/do` - Implement and ship a one-off task

Takes a description of changes, creates an isolated git worktree, implements the changes, creates a PR, merges it, and cleans up the worktree. Like `/work` but for ad-hoc tasks that aren't in the backlog, and isolated in a worktree so it doesn't interfere with your working tree.

**When to use:** When you want to describe a change and have it implemented and shipped end-to-end without touching your current working directory.

**Frequency:** Whenever you have a self-contained task to ship.

```
/do Add input validation to the login form
/do Refactor the logger to use structured output
```

### `/execute-plan` - Execute a multi-PR rollout plan

Reads a plan file from `.private/plans/`, then sequentially implements and mainlines each PR described in the plan. Automatically detects which PRs have already been completed and picks up where it left off.

**When to use:** When you have a large feature broken into an ordered sequence of PRs (created manually or via brainstorming) and want to execute them one by one.

**Frequency:** Once per plan. Can be re-run to resume after interruption.

```
/execute-plan BROWSER_PLAN.md    # executes .private/plans/BROWSER_PLAN.md
/execute-plan AUTH_REFACTOR.md   # executes .private/plans/AUTH_REFACTOR.md
```

### `/blitz` - End-to-end feature execution

Plans a feature from scratch, creates a GitHub project board and milestone issues, swarm-executes them in parallel, sweeps for review feedback, addresses it, and reports a final summary. Combines `/brainstorm` + `/swarm` + `/check-reviews` into a single end-to-end workflow.

The project board is created under the `vellum-ai` org with the naming convention `<github-username>-vellum-assistant`. Milestone issues are added to the board and tracked through Ready → In Progress → In Review → Done.

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
- `--workers N` — number of parallel swarm workers (default: 3)
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
Follow the instructions in scripts/commands/work.md
```

### Check-reviews prompt

```
Follow the instructions in scripts/commands/check-reviews.md
```

### Brainstorm prompt

```
Follow the instructions in scripts/commands/brainstorm.md
```

### Mainline prompt

```
Follow the instructions in scripts/commands/mainline.md
```

### Do prompt

```
Follow the instructions in scripts/commands/do.md
```

### Execute-plan prompt

```
Follow the instructions in scripts/commands/execute-plan.md
```

### Blitz prompt

```
Follow the instructions in scripts/commands/blitz.md <feature description>
```
