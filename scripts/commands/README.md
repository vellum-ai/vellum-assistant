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
```

After symlinking, the commands are available as `/work`, `/check-reviews`, `/brainstorm`, `/swarm`, and `/worktree-plan` in Claude Code.

### 2. Enable fast mode

Before running any command, type `/fast` in your Claude Code session. Fast mode uses the same Opus model but with faster output. It cuts cost in half and reduces latency, which matters when commands are creating branches, running type-checks, and merging PRs in a loop.

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

### `/work` - Execute a single task

Picks the top item from `.private/TODO.md` (or a specific task if you pass an argument), implements it, creates a PR, merges it, and updates the tracking files.

**When to use:** The main workhorse. Run it whenever you want to knock out a task.

**Frequency:** As often as you want, but **one at a time**. Don't run multiple `/work` sessions in parallel -- they'll conflict on the same branch. Use `/swarm` for parallelism.

```
/work                           # picks the top TODO item
/work Fix the broken login flow # works on a specific task
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

### `/worktree-plan` - Plan parallel worktree batches

Reads `.claude/IDEAS.md`, groups selected items into non-conflicting batches, and drafts detailed kickoff prompts for each batch. Useful for planning manual worktree-based parallelism outside of `/swarm`.

**When to use:** When you want more control over how tasks are grouped and sequenced across worktrees.

## Typical workflow

```
/fast                    # enable fast mode
/brainstorm              # generate and approve a task backlog
/swarm 3                 # burn through tasks in parallel
/check-reviews           # see if reviewers left feedback
/work                    # address any feedback items one by one
```

## Using with other coding agents

These commands are designed for Claude Code, but you can run equivalent workflows in other coding agents (Cursor, Windsurf, Codex, Devin, etc.) by sending them the right prompt. Below are copy-paste prompts for each command.

### Work prompt

```
Read .private/TODO.md and handle the first item on the list. This is a Bun + TypeScript project
with code in `assistant/`. Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
All imports use `.js` extensions (NodeNext module resolution).

If the task requires code changes:
1. Verify it's still relevant by checking the codebase. If already addressed, remove it from
   .private/TODO.md and explain why.
2. Implement the change. Type-check: `cd assistant && bunx tsc --noEmit`
3. Create a PR: `gh pr create --title "<title>" --body "<description>"`
4. Merge immediately: `gh pr merge <N> --squash`
5. Append the PR link to .private/UNREVIEWED_PRS.md
6. Append a detailed description of what was done to .private/DONE.md (separated by a horizontal rule)
7. Remove the completed item from .private/TODO.md

If the task says "Address the feedback on <PR URL>", first check if the PR is merged
(`gh pr view <N> --json state,mergedAt`). If not, merge it first with `gh pr merge <N> --squash`.
Then read the review comments and create a new PR with the requested fixes.

IMPORTANT: .private/TODO.md, .private/DONE.md and .private/UNREVIEWED_PRS.md are written to by
other processes. Read before writing, verify after writing.
```

### Check-reviews prompt

```
Check every PR listed in .private/UNREVIEWED_PRS.md for reviews from chatgpt-codex-connector[bot]
and devin-ai-integration[bot].

For each PR, run:
  gh pr view <N> --json comments,reviews,createdAt
  gh api repos/vellum-ai/vellum-assistant/issues/<N>/reactions --jq '[.[] | {user: .user.login, content: .content}]'

Review status:
- Codex: approved = +1 reaction on PR description; changes requested = review/comment with suggestions
- Devin: approved = review containing "No Issues Found"; changes requested = any other review

If a PR is 30+ minutes old and only one reviewer has responded, treat the missing reviewer as
"Skipped" (implicit approval).

Actions:
- Both reviewed (or one + one skipped): remove from UNREVIEWED_PRS.md
- Either real review requested changes: add "- Address the feedback on <PR URL>" to top of .private/TODO.md
- Still waiting on both and PR < 30 min old: leave in UNREVIEWED_PRS.md

Display a summary table with columns: PR, Age, Codex, Devin, Fully Reviewed, Added to TODO, Removed from Unreviewed.

IMPORTANT: .private/TODO.md and .private/UNREVIEWED_PRS.md are written to by other processes.
Read before writing, verify after writing.
```

### Brainstorm prompt

```
Read through the codebase (this is a Bun + TypeScript project, code in `assistant/` and `web/`)
and the existing .private/TODO.md. Come up with a prioritized list of improvements: new features,
bug fixes, security, performance, testing, refactoring, code cleanup, dead code removal, etc.

Present the list for approval. Once approved, update .private/TODO.md as a single bulleted list
ordered by descending priority. Keep any existing "Address the feedback on <PR URL>" items at the top.

IMPORTANT: .private/TODO.md is written to by other processes. Read before writing, verify after writing.
```
