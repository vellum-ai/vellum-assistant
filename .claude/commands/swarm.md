Work through .private/TODO.md using a pool of parallel agents. One task per agent. As agents finish, spawn new ones for the next items. Keep going until the user says to stop or TODO.md is empty.

Arguments (optional): $ARGUMENTS

Parse positional arguments:

- **First argument** (optional): number of parallel workers (default: 3). Example: `/swarm 5` runs 5 workers.
- **Second argument** (optional): maximum number of tasks to complete before automatically shutting down. Example: `/swarm 3 10` runs 3 workers and stops after completing 10 tasks.

If no arguments are provided, default to 3 workers with no task limit (run until TODO.md is empty or the user says to stop).

## Repo-specific gotchas (include these in every agent prompt)

- **gh pr view fields**: `merged` is NOT a valid --json field. Use `state` and `mergedAt` instead: `gh pr view <N> --json state,mergedAt,title,url`
- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- **No piping to tail/head**: `tail` and `head` may not be available in the shell. Avoid `cmd | tail -N`. Instead, run the command directly and let output truncate naturally, or use the Read tool on output files.

## Phase 1: Setup

1. Read .private/TODO.md. Keep an internal list of which items are currently in-flight.
2. Parse the arguments: note the worker count (default: 3) and max-tasks limit (if provided). Track a **completed count** starting at 0.
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

1. Create a worktree: `scripts/worktree create swarm/task-<counter>`.
2. Create a `TaskCreate` entry for tracking.
3. Spawn a `general-purpose` agent via the `Task` tool with `team_name: "swarm"`. The prompt must include:

```
You are working on a single task in an isolated git worktree.

## Project context
- Bun + TypeScript project. Code is in `assistant/`.
- Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
- All imports use `.js` extensions (NodeNext module resolution).

## Repo-specific gotchas
- `gh pr view` does NOT support a `merged` --json field. Use `state` and `mergedAt`: `gh pr view <N> --json state,mergedAt,title,url`
- This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- `tail` and `head` may not be available in the shell. Don't pipe to them.

## Your worktree
<absolute path to worktree>
ALL work happens here. Do NOT touch the main repo.

## Your task
<the TODO item, plus relevant context: file paths, function names, existing patterns>

## Workflow
1. Make the changes in your worktree.
2. Type-check: cd <worktree>/assistant && bunx tsc --noEmit
3. Commit with a descriptive message.
4. Push and create a PR:
   gh pr create --base main --title "<concise title>" --body "<what changed and why>"
5. Merge immediately: gh pr merge <number> --squash
6. Send a message to "lead" with:
   - The PR link
   - A summary of what you changed and why
   - Which files were modified
   - Any issues or concerns

For "Address the feedback on <PR URL>" tasks:
- Read the review comments on the referenced PR to understand what changes are requested.
- Implement the requested fixes in your worktree (on a new branch — this will become a new PR).
- Follow the same PR creation and merge workflow above.
```

## Phase 4: When an agent finishes

1. Read its completion message.
2. Update tracking files (read fresh each time, write back carefully):
   - Remove the completed item from .private/TODO.md.
   - Append a deatiled description of what was done to the end of .private/DONE.md, separated by a horizontal rule.
   - Append the PR link to .private/UNREVIEWED_PRS.md.
3. Mark the TaskCreate entry as completed.
4. Increment the **completed count**.
5. Send the agent a shutdown request.
6. Remove the worktree: `scripts/worktree remove swarm/task-<counter> --delete-branch`.
7. **Report to the user**: show the completed item, the PR link, a summary of what changed, and which files were modified. Don't abbreviate — give enough detail that the user understands what happened without clicking the PR.
8. Remove the item from the in-flight list.
9. Pull the latest main branch to ensure the worktree is up to date.
10. **If the user has NOT signaled stop AND the max-tasks limit has NOT been reached**: pick the next task (Phase 2) and spawn a new agent (Phase 3).
11. **If the user HAS signaled stop OR the max-tasks limit has been reached**: don't spawn. Once all in-flight agents finish, proceed to shutdown.

## Phase 5: Shutdown

When the user says to stop, the max-tasks limit is reached, or TODO.md is empty (and all agents have finished):

1. Let all in-progress agents finish their current task. Do NOT interrupt them.
2. Process all remaining results (update TODO.md, DONE.md, UNREVIEWED_PRS.md, clean up worktrees).
3. Delete the team with `TeamDelete`.
4. Print a final summary table:

   | #   | Item                               | PR   | Status |
   | --- | ---------------------------------- | ---- | ------ |
   | 1   | Fix quadratic string concat        | #210 | merged |
   | 2   | Add foreign key on toolInvocations | #211 | merged |
   | 3   | IPC message size limits            | —    | failed |

## Important

- Don't sleep for more than 15 seconds at a time while waiting for agents to finish.
- .private/TODO.md, .private/DONE.md, and .private/UNREVIEWED_PRS.md are written to by other processes. Always read before writing, verify after writing. These files are gitignored.
- If an agent reports failure, put the item back in TODO.md at its original priority position and note the failure in the summary.
- If an agent hits merge conflicts after another agent's PR landed, tell it to rebase: `git pull --rebase origin main`.
