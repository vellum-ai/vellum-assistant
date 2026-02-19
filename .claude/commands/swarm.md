Work through .private/TODO.md using a pool of parallel agents. One task per agent. As agents finish, spawn new ones for the next items. Keep going until the user says to stop or TODO.md is empty.

Arguments (optional): $ARGUMENTS

Parse positional arguments and flags:

- **First argument** (optional): number of parallel workers (default: 12). Example: `/swarm 5` runs 5 workers.
- **Second argument** (optional): maximum number of tasks to complete before automatically shutting down. Example: `/swarm 8 10` runs 8 workers and stops after completing 10 tasks.
- **`--namespace NAME`** (optional): a short identifier to namespace branch names and avoid conflicts with other parallel swarm runs. If not provided, generate a random 4-character hex string (e.g., `a3f2`) as the namespace.

If no arguments are provided, default to 12 workers with no task limit (run until TODO.md is empty or the user says to stop).

## Repo-specific gotchas (include these in every agent prompt)

- **gh pr view fields**: `merged` is NOT a valid --json field. Use `state` and `mergedAt` instead: `gh pr view <N> --json state,mergedAt,title,url`
- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- **CI**: Do NOT wait for CI checks to pass before merging. Merge immediately.
- **No piping to tail/head**: `tail` and `head` may not be available in the shell. Avoid `cmd | tail -N`. Instead, run the command directly and let output truncate naturally, or use the Read tool on output files.

## Phase 1: Setup

1. Read .private/TODO.md. Keep an internal list of which items are currently in-flight.
2. Parse the arguments: note the worker count (default: 12), max-tasks limit (if provided), and namespace (or generate a random 4-char hex default). Track a **completed count** starting at 0.
3. Create a team with `TeamCreate` (team name: `swarm`).

## Phase 2: Pick the next task

When choosing which item to hand to the next available agent:

- Don't just always pop from the top. Be smart about **conflict avoidance**: look at what's currently in-flight and avoid scheduling a task that's likely to touch the same files or subsystems. For example, don't run two security-related tasks or two IPC tasks at the same time if they'll both modify overlapping files.
- If the top item would conflict with in-flight work, skip it and pick the next non-conflicting item instead. Come back to skipped items when the conflicting work finishes.

### Handling "Address the feedback" items

These are tasks to read review comments on an already-merged PR, then create a NEW PR with the requested fixes. Before handing one off:

- Check if the referenced PR is merged. If not, merge it first (the review system only reviews on initial push, so PRs are never updated after opening).
- Then hand the task to an agent like any other item.

## Phase 3: Spawn an agent

For each task being handed off:

1. Create a worktree: `.claude/worktree create swarm/<namespace>/task-<counter>`.
2. Create a `TaskCreate` entry for tracking.
3. Spawn a `general-purpose` agent via the `Task` tool with `team_name: "swarm"`. The prompt must include:

```
You are working on a single task in an isolated git worktree.

## Project context
Read AGENTS.md in the repo root for project conventions and structure.

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
   cd <worktree> && .claude/ship --commit-msg "<message>" --title "<title>" --body "<summary>" --base main --merge --assignee @me
4. Send a message to "lead" with:
   - The PR link (printed by .claude/ship)
   - A summary of what you changed and why
   - Which files were modified
   - Any issues or concerns

For "Address the feedback on <PR URL>" tasks:
- Read the review comments on the referenced PR to understand what changes are requested.
- Implement the requested fixes in your worktree (on a new branch — this will become a new PR).
- Follow the same PR creation and merge workflow above.
- After creating the followup PR, leave a paper trail on the original PR:
  1. Comment on the original PR: `gh pr comment <original-PR-number> --body "Addressed in <new-PR-URL>"`
  2. Resolve all bot review threads: `.claude/gh-review resolve-threads <original-PR-number> "Addressed in <new-PR-URL>"`

For "Fix CI failures from merged PR <PR URL> (run: <run URL>)" tasks:
- Open the failed run URL and read the logs to understand what failed.
- Read the referenced PR's diff (`gh pr diff <number>`) to understand what changes were introduced.
- Diagnose the root cause of the CI failure.
- Implement the fix in your worktree (on a new branch — this will become a new PR).
- Follow the same PR creation and merge workflow above.
- In the new PR body, reference the original PR and the failed run.
```

## Phase 4: When an agent finishes

1. Read its completion message.
2. Update tracking files (read fresh each time, write back carefully):
   - Remove the completed item from .private/TODO.md.
   - Append the PR link to .private/UNREVIEWED_PRS.md.
3. Mark the TaskCreate entry as completed.
4. Increment the **completed count**.
5. Send the agent a shutdown request.
6. Remove the worktree: `.claude/worktree remove swarm/<namespace>/task-<counter> --delete-branch`.
7. **Report to the user**: show the completed item, the PR link, a summary of what changed, and which files were modified. Don't abbreviate — give enough detail that the user understands what happened without clicking the PR.
8. Remove the item from the in-flight list.
9. Pull the latest main branch to ensure the worktree is up to date.
10. **If the user has NOT signaled stop AND the max-tasks limit has NOT been reached**: pick the next task (Phase 2) and spawn a new agent (Phase 3).
11. **If the user HAS signaled stop OR the max-tasks limit has been reached**: don't spawn. Once all in-flight agents finish, proceed to shutdown.

## Phase 5: Shutdown

When the user says to stop, the max-tasks limit is reached, or TODO.md is empty (and all agents have finished):

1. Let all in-progress agents finish their current task. Do NOT interrupt them.
2. Process all remaining results (update TODO.md, UNREVIEWED_PRS.md, clean up worktrees).
3. Delete the team with `TeamDelete`.
4. Print a final summary table:

   | #   | Item                               | PR   | Status |
   | --- | ---------------------------------- | ---- | ------ |
   | 1   | Fix quadratic string concat        | #210 | merged |
   | 2   | Add foreign key on toolInvocations | #211 | merged |
   | 3   | IPC message size limits            | —    | failed |

## Important

- Don't sleep for more than 15 seconds at a time while waiting for agents to finish.
- .private/TODO.md and .private/UNREVIEWED_PRS.md are written to by other processes. Always read before writing, verify after writing. These files are gitignored.
- If an agent reports failure, put the item back in TODO.md at its original priority position and note the failure in the summary.
- If an agent hits merge conflicts after another agent's PR landed, tell it to rebase: `git pull --rebase origin main`.
