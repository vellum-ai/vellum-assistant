Plan a feature end-to-end, create GitHub issues on the project board, swarm-execute them in parallel onto a feature branch, sweep for review feedback, address it, and present the final PR for manual review.

Unlike `/blitz`, this command does NOT merge directly to main. Instead, it creates a **feature branch**, merges all milestone PRs into that branch, and at the end opens a single PR from the feature branch into main for you to review before merging.

The user passed: `$ARGUMENTS`

If `$ARGUMENTS` is empty, stop and tell the user to provide a feature description. Example: `/safe-blitz Add WebSocket transport for daemon IPC`.

## Parsing flags

Extract these flags from `$ARGUMENTS` before treating the remainder as the feature description:

- `--auto` — skip the pause between rounds (default: pause and ask before sweep)
- `--workers N` — parallel worker count for swarm phases (default: 12)
- `--skip-plan` — skip planning; use issues already in the "Ready" column of the GH project
- `--branch NAME` — custom feature branch name (default: auto-generated from feature description as `feature/<kebab-case-summary>`)

Everything after stripping flags is the **feature description**.

## Repo-specific gotchas (include these in every agent prompt)

- **gh pr view fields**: `merged` is NOT a valid --json field. Use `state` and `mergedAt` instead: `gh pr view <N> --json state,mergedAt,title,url`
- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- **CI**: Do NOT wait for CI checks to pass before merging. Merge immediately.
- **No piping to tail/head**: `tail` and `head` may not be available in the shell. Don't pipe to them.
- **Bun PATH**: Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
- **Imports**: All imports use `.js` extensions (NodeNext module resolution).
- **Project structure**: Bun + TypeScript project. Code is in `assistant/`.

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

## Phase 1.5: Create the Feature Branch

This is the key difference from `/blitz`. All milestone work merges into this branch instead of main.

1. Determine the feature branch name:
   - If `--branch NAME` was passed, use that.
   - Otherwise, generate one from the feature description: `feature/<kebab-case-summary>` (e.g., `feature/websocket-ipc-transport`). Keep it under 50 characters.

2. Create and push the feature branch from the latest main **without switching your working tree**:

```bash
git fetch origin main
git branch <feature-branch-name> origin/main
git push -u origin <feature-branch-name>
```

This keeps your current branch unchanged so safe-blitz doesn't block your main working tree.

3. Store the feature branch name for later phases. All agents will use `--base <feature-branch-name>` instead of `--base main`.

## Phase 2: Plan & Spec

**If `--skip-plan` was passed**, skip issue creation. Instead:

1. Fetch existing "Ready" issues from the project board and use those as the milestones.
2. Identify the project-level issue (the epic). Look for an open issue in "In Progress" status that references milestones, or ask the user to provide the project issue number. This is required — Phase 6 needs it to set the project status and reference it in the final PR.
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

## Feature branch
`<feature-branch-name>`

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
   - The feature branch name
   - A numbered list of milestones with their issue links and dependency order
   - Note: "All milestone PRs will target the feature branch `<name>`. A final PR into main will be created at the end for your review."
   - Ask: "Proceed with execution?"

   Do NOT continue until the user confirms.

## Phase 3: Populate TODO.md

1. Read `.private/TODO.md` (preserve existing items).
2. Prepend milestone issues as TODO items at the top:

```
- M1: <title> (#<issue-number>)
- M2: <title> (#<issue-number>)
...
```

3. Write the updated file back. Verify the write preserved existing items.

## Phase 4: Swarm (Feature Branch Mode)

This works like the standard swarm but with a critical difference: **all PRs target the feature branch, not main**.

For each task being handed off:

1. Create a worktree **from the feature branch** (not main):

```bash
.claude/worktree create swarm/task-<counter> origin/<feature-branch-name>
```

2. Create a `TaskCreate` entry for tracking.
3. Spawn a `general-purpose` agent via the `Task` tool. The prompt must include:

```
You are working on a single task in an isolated git worktree.

## Project context
- Bun + TypeScript project. Code is in `assistant/`.
- Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
- All imports use `.js` extensions (NodeNext module resolution).

## Repo-specific gotchas
- `gh pr view` does NOT support a `merged` --json field. Use `state` and `mergedAt`: `gh pr view <N> --json state,mergedAt,title,url`
- This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- Do NOT wait for CI checks to pass before merging. Merge immediately.
- `tail` and `head` may not be available in the shell. Don't pipe to them.

## Your worktree
<absolute path to worktree>
ALL work happens here. Do NOT touch the main repo.

## Your task
<the TODO item, plus relevant context: file paths, function names, existing patterns>

## Workflow
1. Make the changes in your worktree.
2. Do NOT run tests, type-checking (tsc), or linting unless the task specifically requires it (e.g., "fix the type errors", "make the tests pass").
3. cd back to worktree root, then ship (.claude/ship MUST run from the repo root, not assistant/):
   cd <worktree> && .claude/ship --commit-msg "<message>" --title "<title>" --body "## Summary
<1-3 bullet points>

## Task
<the exact TODO item text you were given>

🤖 Generated with [Claude Code](https://claude.com/claude-code)" --base <feature-branch-name> --merge --assignee @me
4. Send a message to "lead" with:
   - The PR link (printed by .claude/ship)
   - A summary of what you changed and why
   - Which files were modified
   - Any issues or concerns

For "Address the feedback on <PR URL>" tasks:
- Read the review comments on the referenced PR to understand what changes are requested.
- Implement the requested fixes in your worktree (on a new branch — this will become a new PR).
- Follow the same PR creation and merge workflow above (targeting the feature branch).
```

### When an agent finishes

1. Read its completion message.
2. Update tracking files (read fresh each time, write back carefully):
   - Remove the completed item from .private/TODO.md.
   - Append the PR link to .private/UNREVIEWED_PRS.md.
3. Mark the TaskCreate entry as completed.
4. Increment the **completed count**.
5. Remove the worktree: `.claude/worktree remove swarm/task-<counter> --delete-branch`.
6. **Report to the user**: show the completed item, the PR link, a summary of what changed, and which files were modified. Don't abbreviate.
7. Remove the item from the in-flight list.
8. Pull the latest **feature branch** (not main):

```bash
git fetch origin <feature-branch-name>
```

9. **After each milestone task completes and its PR merges**, update the corresponding GitHub issue. Skip this for non-milestone tasks (e.g., "Address the feedback on ..." items):

```bash
.claude/gh-project set-status <issue-number> done
gh issue close <issue-number>
```

10. **If the user has NOT signaled stop AND the max-tasks limit has NOT been reached**: pick the next task and spawn a new agent.
11. **If the user HAS signaled stop OR the max-tasks limit has been reached**: don't spawn. Once all in-flight agents finish, proceed to shutdown.

## Phase 5: Sweep

1. Unless `--auto` was passed, pause and ask the user: **"Initial swarm complete. Run sweep for review feedback?"**
   - If the user declines, skip to Phase 6.

2. Run the check-reviews workflow by reading and following `.claude/commands/check-reviews.md`.

3. After check-reviews completes, read `.private/TODO.md`:
   - If new "Address the feedback" items were added, run another swarm pass (back to Phase 4).
   - If no new feedback items, proceed to Phase 6.

4. If `--auto` was passed, skip the pause and run the sweep automatically. Still loop back to Phase 4 if feedback items were added.

## Phase 6: Create Final PR (Feature Branch → Main)

This is the key difference from `/blitz`. Instead of closing the epic, we create the final PR.

1. Update the project-level issue status to "In Review":

```bash
.claude/gh-project set-status <project-issue-number> in-review
```

2. Create the final PR from the feature branch into main. **Do NOT merge it.**

```bash
gh pr create --base main --head <feature-branch-name> --title "<Feature Title>" --body "$(cat <<'EOF'
## Summary
<1-3 sentence overview of the feature>

## Changes
<bulleted list of all milestone changes>

## Milestone PRs (merged into feature branch)
- #<pr1>: <title>
- #<pr2>: <title>
- ...

## Project issue
Closes #<project-issue-number>

## Test plan
- [ ] <verification steps>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" --assignee @me
```

3. Get the project board URL:

```bash
gh project view "$GH_PROJECT_NUMBER" --owner "$GH_PROJECT_OWNER" --format json | jq -r '.url'
```

4. Print a final summary:

```
## Safe Blitz Complete

**Feature:** <feature description>
**Project issue:** #<number> (<link>)
**Project board:** <board-url>
**Feature branch:** `<feature-branch-name>`

### Final PR (ready for review — NOT auto-merged):
<PR URL>

| #   | Milestone                          | Issue | PR   | Status              |
| --- | ---------------------------------- | ----- | ---- | ------------------- |
| M1  | <title>                            | #10   | #15  | merged → feature    |
| M2  | <title>                            | #11   | #16  | merged → feature    |
| M3  | <title>                            | #12   | #17  | merged → feature    |

**Feedback PRs:** <count, if any>

⚠️ The final PR is open and waiting for your review. Merge it when ready.
```

## Important

- `.private/TODO.md` and `.private/UNREVIEWED_PRS.md` are written to by other processes. Always read before writing, verify after writing. These files are gitignored.
- Don't sleep for more than 15 seconds at a time while waiting for agents to finish.
- If an agent reports failure, put the item back in TODO.md and note the failure.
- If an agent hits merge conflicts after another agent's PR landed, tell it to rebase against the **feature branch**: `git pull --rebase origin <feature-branch-name>`.
- Use `.claude/worktree` for isolation (same as swarm).
- **Do NOT merge the final PR.** Only create it and present the link to the user.
