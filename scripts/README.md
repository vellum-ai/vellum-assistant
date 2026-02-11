# Automation Commands

This directory contains slash commands for Claude Code that automate development workflows. They manage a shared task list (`.private/TODO.md`), create PRs, merge them, and track review status.

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
ln -s ../../scripts/commands/worktree-plan.md worktree-plan.md
ln -s ../../scripts/commands/mainline.md mainline.md
```

After symlinking, the commands are available as `/work`, `/check-reviews`, `/brainstorm`, `/swarm`, `/worktree-plan`, and `/mainline` in Claude Code.

### 2. Enable fast mode

Before running any command, type `/fast` in your Claude Code session. Fast mode uses the same Opus model but with faster output.

It's the exact same model but with massively reduced latency (2.5x faster) and increased cost (6x cost).

However, time is money, so please use it generously for anything that's not meant to be asynchronous.
You should use this almost all the time.

If you have trouble rationalizing this, remember that even at 600% the price, it's still an order of magnitude cheaper than you sitting there and waiting for a response.
If you don't use it, you're wasting money and making Akash sad.

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
/fast
/brainstorm                                             # generate a general task backlog for the entire project
/brainstorm focus on ideas relating to the desktop app  # generate a task backlog focused on the desktop app
```

### `/work` - Execute a single task

Picks the top item from `.private/TODO.md` (or a specific task if you pass an argument), implements it, creates a PR, merges it, and updates the tracking files.

**When to use:** The main workhorse. Run it whenever you want to knock out a task.

**Frequency:** As often as you want, but **one at a time**. Don't run multiple `/work` sessions in parallel -- they'll conflict on the same branch. Use `/swarm` for parallelism.

```
/fast
/work                            # picks the top TODO item
/work Fix the broken login flow  # works on a specific task
```

### `/swarm` - Parallel task execution

Spawns a pool of agents that work through `.private/TODO.md` in parallel using isolated git worktrees. Each agent picks a non-conflicting task, creates a PR, merges it, and reports back. The lead agent manages scheduling to avoid file conflicts.

**When to use:** When you have a backlog of independent tasks and want to burn through them fast.

**Frequency:** On demand. Can run for extended periods.

```
/fast
/swarm       # 3 parallel workers, runs until TODO.md is empty
/swarm 5     # 5 parallel workers
/swarm 3 10  # 3 workers, stop after 10 tasks completed
```

### `/mainline` - Ship current changes to main

Takes all uncommitted changes, creates a branch, commits, opens a PR, merges it via squash, adds the PR to the unreviewed list, and switches back to main. A one-shot command for shipping adhoc work.

**When to use:** When you've been working on something interactively and want to ship it without manually going through the branch/PR/merge dance.

**Frequency:** Whenever you have uncommitted changes to ship.

```
/mainline                          # infers PR title from the changes
/mainline Fix login redirect bug   # uses the provided title
```

### `/check-reviews` - Process PR review feedback

Checks every PR in `.private/UNREVIEWED_PRS.md` for reviews from the automated reviewers (Codex and Devin bots). If reviewers requested changes, it adds "Address the feedback on \<PR>" tasks to the top of `.private/TODO.md`. Fully reviewed PRs are removed from the unreviewed list. PRs waiting 30+ minutes for a single reviewer are skipped (implicit approval).

**When to use:** Run periodically after merging PRs to see if reviewers flagged anything. The feedback tasks it creates are then picked up by `/work` or `/swarm`.

**Frequency:** Every 30-60 minutes while PRs are pending review, or whenever you want a status check.

```
/check-reviews
```

## Typical workflow

3 shells with Claude Code open, one for each of work/swarm, check-reviews, and brainstorm.

### Work / Swarm

This is the main workflow.

```
/fast
/work
/work
/work
...
```

```
/fast
/work Address the feedback on https://github.com/vellum-ai/vellum-assistant/pull/999
...
```

```
/fast
/swarm 4 # run 4 workers, never give up, never surrender
...
```

```
/fast
/swarm 4 20 # run 4 workers, stop after 20 tasks
...
```

### Check-reviews

Run this periodically to make sure you're not missing any feedback on merged PRs.

```
# No need to fast mode here unless you need this to run quickly for some reason
/check-reviews # see if reviewers left feedback
...
```

### Brainstorm

```
/fast                    # enable fast mode
/brainstorm              # generate and approve a task backlog
```

```
/fast
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

### Mainline prompt

```
Follow the instructions in scripts/commands/mainline.md
```

### Brainstorm prompt

```
Follow the instructions in scripts/commands/brainstorm.md
```
