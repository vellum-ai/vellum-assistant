Plan a feature end-to-end, create GitHub issues on the project board, swarm-execute them in parallel, sweep for review feedback, address it, and report.

The user passed: `$ARGUMENTS`

If `$ARGUMENTS` is empty, stop and tell the user to provide a feature description. Example: `/blitz Add WebSocket transport for daemon IPC`.

## Parsing flags

Extract these flags from `$ARGUMENTS` before treating the remainder as the feature description:

- `--auto` — skip the pause between rounds (default: pause and ask before sweep)
- `--workers N` — parallel worker count for swarm phases (default: 12)
- `--skip-plan` — skip planning; use issues already in the "Ready" column of the GH project

Everything after stripping flags is the **feature description**.

## Namespace

Derive a short namespace slug from the feature description to avoid conflicts with parallel swarms. Take the first 3-4 meaningful words of the feature description, convert to kebab-case, and truncate to 20 characters max (e.g., "Add WebSocket transport for daemon IPC" → `ws-daemon-ipc`). This namespace is used for:
- Prefixing milestone labels in TODO.md to distinguish tasks from different blitzes
- Namespacing swarm branch names to avoid worktree collisions

## Repo-specific gotchas (include these in every agent prompt)

- **gh pr view fields**: `merged` is NOT a valid --json field. Use `state` and `mergedAt` instead: `gh pr view <N> --json state,mergedAt,title,url`
- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- **CI**: Do NOT wait for CI checks to pass before merging. Merge immediately.
- **No piping to tail/head**: `tail` and `head` may not be available in the shell. Don't pipe to them.

## Phase 1: Project Setup

1. If `.private/project-config.env` does not exist, create the project board:

```bash
if [ ! -f .private/project-config.env ]; then
  .claude/gh-project init
fi
```

2. Source the config for later use:

```bash
source .private/project-config.env
```

This provides: `GH_PROJECT_NUMBER`, `GH_PROJECT_OWNER`, `GH_PROJECT_ID`, and status option IDs.

## Phase 2: Plan & Spec

**If `--skip-plan` was passed**, skip issue creation. Instead:

1. Fetch existing "Ready" issues from the project board and use those as the milestones.
2. Identify the project-level issue (the epic). Look for an open issue in "In Progress" status that references milestones, or ask the user to provide the project issue number. This is required — Phase 6 needs it to close out the project.
3. Proceed to Phase 3 with the fetched milestones.

**Otherwise:**

1. Analyze the feature description with extended thinking. Consider:
   - What the feature requires architecturally
   - How it fits into the existing codebase
   - What the logical milestones are (ordered by dependency)
   - What can be parallelized

2. Create a **project-level issue** — the epic/umbrella for this feature. Assign it to the current GitHub user:

```bash
GH_USERNAME=$(gh api user --jq '.login')
gh issue create --assignee "$GH_USERNAME" --title "<Feature Title>" --body "$(cat <<'EOF'
## Overview
<what this feature does>

## Goals
- <goal 1>
- <goal 2>

## Non-goals
- <explicit non-goal>

## Approach
<high-level implementation approach>

## Milestones
- [ ] M1: <title>
- [ ] M2: <title>
- ...
EOF
)"
```

3. Create **milestone issues** (M1, M2, ...) — one per PR-sized chunk of work. Assign to the same GitHub user:

```bash
gh issue create --assignee "$GH_USERNAME" --title "M1: <milestone title>" --body "$(cat <<'EOF'
## Context
Part of #<project-issue-number>: <feature title>

## Implementation
- <specific file changes>
- <functions to add/modify>
- <tests to write>

## Dependencies
- Depends on: <none | M<n>>
- Blocks: <M<n> | none>
EOF
)"
```

4. Add all issues to the GH project board and set their statuses:

```bash
# Project-level (epic) issue → in-progress
.claude/gh-project add-issue <epic-issue-number> --status in-progress

# Milestone issues → ready (repeat for each)
.claude/gh-project add-issue <milestone-issue-number> --status ready
```

5. **Present the plan to the user for approval.** Show:
   - The project-level issue link
   - A numbered list of milestones with their issue links and dependency order
   - Ask: "Proceed with execution?"

   Do NOT continue until the user confirms.

## Phase 3: Populate TODO.md

1. Read `.private/TODO.md` (preserve existing items).
2. Prepend milestone issues as TODO items at the top, prefixed with the namespace:

```
- [<namespace>] M1: <title> (#<issue-number>)
- [<namespace>] M2: <title> (#<issue-number>)
...
```

3. Write the updated file back. Verify the write preserved existing items.

## Phase 4: Swarm

Read and follow the instructions in `.claude/commands/swarm.md` with these modifications:

- Pass the `--workers` count (or default: 12) as the first argument.
- Pass `--namespace <namespace>` to use the derived namespace for branch naming.
- **After each milestone task completes and its PR merges**, update the corresponding GitHub issue. Skip this for non-milestone tasks (e.g., "Address the feedback on ..." items from Phase 5 — those are PR-based and have no associated milestone issue):
  1. Set the project board status to "Done" and close the issue:

```bash
.claude/gh-project set-status <issue-number> done
gh issue close <issue-number>
```

- Everything else follows the standard swarm workflow (worktrees, conflict avoidance, TODO/DONE/UNREVIEWED tracking).

## Phase 5: Sweep

1. Unless `--auto` was passed, pause and ask the user: **"Initial swarm complete. Run sweep for review feedback?"**
   - If the user declines, skip to Phase 6.

2. Run the check-reviews workflow by reading and following `.claude/commands/check-reviews.md`, passing `--namespace <namespace>` so that only PRs from this blitz are checked and any TODO items added are prefixed with the namespace.

3. After check-reviews completes, read `.private/TODO.md`:
   - If new `[<namespace>]`-prefixed "Address the feedback" or "Fix CI failures" items were added, run another swarm pass (back to Phase 4).
   - If no new namespaced feedback items, proceed to Phase 6.

4. If `--auto` was passed, skip the pause and run the sweep automatically. Still loop back to Phase 4 if feedback items were added.

## Phase 6: Report

1. Update the project-level issue status to "Done" and close it:

```bash
.claude/gh-project set-status <project-issue-number> done
gh issue close <project-issue-number>
```

3. Get the project board URL using the persisted project number:

```bash
gh project view "$GH_PROJECT_NUMBER" --owner "$GH_PROJECT_OWNER" --format json | jq -r '.url'
```

4. Print a final summary:

```
## Blitz Complete

**Feature:** <feature description>
**Project issue:** #<number> (<link>)
**Project board:** <board-url>

| #   | Milestone                          | Issue | PR   | Status |
| --- | ---------------------------------- | ----- | ---- | ------ |
| M1  | <title>                            | #10   | #15  | merged |
| M2  | <title>                            | #11   | #16  | merged |
| M3  | <title>                            | #12   | #17  | merged |

**Feedback PRs:** <count, if any>
```

## Important

- `.private/TODO.md` and `.private/UNREVIEWED_PRS.md` are written to by other processes. Always read before writing, verify after writing. These files are gitignored.
- Don't sleep for more than 15 seconds at a time while waiting for agents to finish.
- If an agent reports failure, put the item back in TODO.md and note the failure.
- If an agent hits merge conflicts, tell it to rebase: `git pull --rebase origin main`.
- Use `.claude/worktree` for isolation (same as swarm).
