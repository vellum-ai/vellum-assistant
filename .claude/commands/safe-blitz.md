Plan a feature end-to-end, create GitHub issues on the project board, execute milestones sequentially with per-milestone review gates onto a feature branch, and present the final PR for manual review.

Unlike `/blitz`, this command does NOT merge directly to main. Instead, it creates a **feature branch** and processes milestones **one at a time** — each milestone is executed, merged into the feature branch, and then recursively swept for review feedback until all feedback (including transitive feedback) is exhausted before moving to the next milestone. After all milestones are complete, a final sweep runs on the entire feature branch. Only then is a single PR from the feature branch into main created for you to review before merging.

The user passed: `$ARGUMENTS`

If `$ARGUMENTS` is empty, stop and tell the user to provide a feature description. Example: `/safe-blitz Add WebSocket transport for daemon IPC`.

## Parsing flags

Extract these flags from `$ARGUMENTS` before treating the remainder as the feature description:

- `--auto` — skip the pause between rounds (default: pause and ask before sweep)
- `--workers N` — parallel worker count for swarm phases (default: 12)
- `--skip-plan` — skip planning; use issues already in the "Ready" column of the GH project
- `--branch NAME` — custom feature branch name (default: auto-generated from feature description as `feature/<kebab-case-summary>`)

Everything after stripping flags is the **feature description**.

Read and follow `.claude/phases/namespace.md`.

Read and follow `.claude/phases/repo-gotchas.md`. Include these gotchas in every agent prompt.

## Phase 1: Project Setup

Read and follow `.claude/phases/project-setup.md`.

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

Read and follow `.claude/phases/plan-and-spec.md`. For safe-blitz mode, replace `<EXTRA_EPIC_FIELDS>` with:
```
## Feature branch
`<feature-branch-name>`
```

When presenting the plan for approval, also show:
- The feature branch name
- Note: "All milestone PRs will target the feature branch `<name>`. A final PR into main will be created at the end for your review."

## Phase 3: Prepare Milestone List

Do NOT use `.claude/phases/populate-todo.md` here. Instead, maintain an internal ordered list of milestones (M1, M2, ..., MN) with their titles and GitHub issue numbers. These milestones will be executed **one at a time** in Phase 4 — do NOT write them all to TODO.md at once.

- **If planning was performed** (no `--skip-plan`): use the milestones from the plan created in Phase 2.
- **If `--skip-plan` was passed**: use the milestones fetched from existing "Ready" issues in Phase 2 (see `.claude/phases/plan-and-spec.md` skip-plan path). Order them by issue number (ascending) unless a dependency order is apparent from the issue descriptions.

## Phase 4: Execute Milestones with Review Gates

Process milestones **one at a time** (sequentially). For each milestone, execute it, merge its PR into the feature branch, then run a recursive sweep to exhaust all feedback before moving to the next milestone. This ensures each milestone is fully reviewed before the next one starts.

The safe-blitz only considers a milestone "done" when its PR AND all transitive feedback PRs have been fully reviewed with no remaining change requests.

### Agent prompt template

The following prompt template is used for both milestone tasks and feedback tasks:

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
   cd <worktree> && .claude/ship --commit-msg "<message>" --title "<title>" --body "<summary>" --base <feature-branch-name> --merge --assignee @me
4. If the PR warrants focused human review, leave a Human Attention Comment (see "Human Attention Comments on PRs" in AGENTS.md). Skip for routine changes.
5. Send a message to "lead" with:
   - The PR link (printed by .claude/ship)
   - A summary of what you changed and why
   - Which files were modified
   - Any issues or concerns

For "Address the feedback on <PR URL>" tasks:
- Read the review comments on the referenced PR to understand what changes are requested.
- Implement the requested fixes in your worktree (on a new branch — this will become a new PR).
- Follow the same PR creation and merge workflow above (targeting the feature branch).
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

### For each milestone (in order):

#### 4a. Add to TODO.md and execute

1. Prepend this single milestone item to `.private/TODO.md` (preserve existing items) with the namespace prefix:
   ```
   - [<namespace>] M<N>: <title> (#<issue-number>)
   ```
2. Create a worktree **from the feature branch** (not main):
   ```bash
   .claude/worktree create swarm/<namespace>/task-<counter> origin/<feature-branch-name>
   ```
3. Create a `TaskCreate` entry for tracking.
4. Spawn a `general-purpose` agent via the `Task` tool using the agent prompt template above.

#### 4b. When the milestone agent finishes

1. Read its completion message.
2. Update tracking files (read fresh each time, write back carefully):
   - Remove the completed item from .private/TODO.md.
   - Append the PR link to .private/UNREVIEWED_PRS.md.
3. Mark the TaskCreate entry as completed.
4. Remove the worktree: `.claude/worktree remove swarm/<namespace>/task-<counter> --delete-branch`.
5. **Report to the user**: show the completed item, the PR link, a summary of what changed, and which files were modified. Don't abbreviate.
6. Pull the latest **feature branch** (not main):
   ```bash
   git fetch origin <feature-branch-name>
   ```

#### 4c. Per-milestone recursive sweep

Run the recursive sweep (`.claude/phases/sweep.md`) with `--namespace <namespace>` and `--branch <feature-branch-name>`. **Skip the entry pause** — treat as `--auto` for per-milestone sweeps. The user-facing pause only applies to the final sweep in Phase 5.

When the sweep says "back to the Swarm phase," run the swarm workflow (`.claude/commands/swarm.md`) with these modifications:
- Pass `--namespace <namespace>` so only namespaced feedback items are processed.
- Pass the worker count as the first positional argument (or default: 12), e.g., `.claude/commands/swarm.md 12 --namespace <namespace>`.
- All agents must use `--base <feature-branch-name>` (not main).
- Create worktrees from the feature branch: `.claude/worktree create swarm/<namespace>/task-<counter> origin/<feature-branch-name>`.

Since milestones are added to TODO.md one at a time (and removed when executed), the only namespaced items in TODO.md during the sweep are feedback items for the current milestone. The swarm will process those and nothing else.

When the sweep says "final phase," proceed to step 4d.

#### 4d. Close the milestone and proceed

1. Set the milestone's GitHub issue status to "Done" and close it:
   ```bash
   .claude/gh-project set-status <issue-number> done
   gh issue close <issue-number>
   ```
2. Move to the next milestone and repeat from step 4a. Continue until all milestones are processed.

## Phase 5: Final Feature Branch Sweep

After all milestones are merged and their individual reviews are clean, run one final recursive sweep on the entire feature branch.

Read and follow `.claude/phases/sweep.md` with `--namespace <namespace>` and `--branch <feature-branch-name>`. Unless `--auto` was passed, this is where the user-facing pause happens: **"All milestones complete. Run final sweep for review feedback?"**

This final sweep catches:
- Any cross-milestone issues that individual per-milestone sweeps missed
- CI failures that only manifest when multiple milestones are combined
- Any remaining unreviewed PRs from any milestone

When the sweep says "back to the Swarm phase," run swarm as described in Phase 4c. When the sweep says "final phase," proceed to Phase 6.

## Phase 6: Create Final PR (Feature Branch -> Main)

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

Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" --assignee @me
```

3. If the final PR warrants focused human review, leave a Human Attention Comment (see "Human Attention Comments on PRs" in AGENTS.md). Skip for routine changes.

4. Get the project board URL:

```bash
gh project view "$GH_PROJECT_NUMBER" --owner "$GH_PROJECT_OWNER" --format json | jq -r '.url'
```

5. Print a final summary:

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
| M1  | <title>                            | #10   | #15  | merged -> feature    |
| M2  | <title>                            | #11   | #16  | merged -> feature    |
| M3  | <title>                            | #12   | #17  | merged -> feature    |

**Feedback PRs:** <count, if any>

The final PR is open and waiting for your review. Merge it when ready.
```

## Important

Read and follow `.claude/phases/blitz-important.md`. Additionally:
- If an agent hits merge conflicts after another agent's PR landed, tell it to rebase against the **feature branch**: `git pull --rebase origin <feature-branch-name>`.
- **Do NOT merge the final PR.** Only create it and present the link to the user.
