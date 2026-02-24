Plan a feature end-to-end, create GitHub issues on the project board, execute milestones sequentially with per-milestone review gates onto a feature branch, and present the final PR for manual review.

Unlike `/blitz`, this command does NOT merge directly to main. Instead, it creates a **feature branch** and processes milestones **one at a time** — each milestone is executed, then recursively swept for review feedback until all feedback (including transitive feedback) is exhausted. Only after reviews are fully clean is the milestone PR merged into the feature branch. After all milestones are complete, a final sweep runs on the entire feature branch. Only then is a single PR from the feature branch into main created for you to review before merging.

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

3. Store the feature branch name for later phases. Milestone agents will use `--base <feature-branch-name>`. Feedback agents during per-milestone sweeps will use `--base <milestone-pr-branch>` (see Phase 4c).

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

**CRITICAL: Review-before-merge policy.** Milestone PRs must NOT be merged into the feature branch until all reviews are addressed and there is no pending feedback. The merge happens only after the per-milestone sweep completes cleanly. This is the defining guarantee of safe-blitz — if a PR is merged before reviews are clean, the review gate is meaningless.

Process milestones **one at a time** (sequentially). For each milestone, execute it, run a recursive sweep to exhaust all review feedback, and only THEN merge the milestone PR into the feature branch. This ensures each milestone is fully reviewed before its code lands on the feature branch.

The safe-blitz only considers a milestone "done" when its PR AND all transitive feedback PRs have been fully reviewed with no remaining change requests, AND the milestone PR has been merged into the feature branch after the sweep.

### Agent prompt template

The following prompt template is used for both milestone tasks and feedback tasks. The `<base-branch>` placeholder is filled in by the lead when spawning the agent:
- For **milestone tasks**: `<base-branch>` = `<feature-branch-name>`
- For **feedback tasks during per-milestone sweep**: `<base-branch>` = `<milestone-pr-branch>` (the milestone PR's head branch)
- For **feedback tasks during final sweep** (Phase 5): `<base-branch>` = `<feature-branch-name>`

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
   cd <worktree> && .claude/ship --commit-msg "<message>" --title "<title>" --body "<summary>" --base <base-branch> --assignee @me
   IMPORTANT: Do NOT use --merge. The lead will merge PRs after reviews are complete.
4. If the PR warrants focused human review, leave a Human Attention Comment (see "Human Attention Comments on PRs" in AGENTS.md). Skip for routine changes.
5. Send a message to "lead" with:
   - The PR link (printed by .claude/ship)
   - A summary of what you changed and why
   - Which files were modified
   - Any issues or concerns

For "Address the feedback on <PR URL>" tasks:
- Read the review comments on the referenced PR to understand what changes are requested.
- Implement the requested fixes in your worktree (on a new branch — this will become a new PR).
- Follow the same PR creation workflow above (using the same --base branch). Do NOT use --merge.
- After creating the followup PR, leave a paper trail on the original PR:
  1. Comment on the original PR: `gh pr comment <original-PR-number> --body "Addressed in <new-PR-URL>"`
  2. Resolve all bot review threads: `.claude/gh-review resolve-threads <original-PR-number> "Addressed in <new-PR-URL>"`

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
2. **Record the milestone PR number, URL, and head branch name.** You will need these for Phase 4c (creating feedback worktrees from the milestone branch) and Phase 4c.5 (merging after reviews). To get the head branch name:
   ```bash
   gh pr view <milestone-pr-number> --json headRefName --jq '.headRefName'
   ```
3. Update tracking files (read fresh each time, write back carefully):
   - Remove the completed item from .private/TODO.md.
   - Append the PR link to .private/UNREVIEWED_PRS.md.
4. Mark the TaskCreate entry as completed.
5. Remove the worktree but **keep the branch** (the PR is still open and unmerged):
   ```bash
   .claude/worktree remove swarm/<namespace>/task-<counter> --no-delete-branch
   ```
6. **Report to the user**: show the completed item, the PR link, a summary of what changed, and which files were modified. Don't abbreviate.
7. Fetch the milestone PR's branch for use in Phase 4c:
   ```bash
   git fetch origin <milestone-pr-branch>
   ```

#### 4c. Per-milestone recursive sweep

Run the recursive sweep (`.claude/phases/sweep.md`) with `--namespace <namespace>`. **Skip the entry pause** — treat as `--auto` for per-milestone sweeps. The user-facing pause only applies to the final sweep in Phase 5.

When the sweep says "back to the Swarm phase," run the swarm workflow (`.claude/commands/swarm.md`) with these modifications:
- Pass `--namespace <namespace>` so only namespaced feedback items are processed.
- Pass the worker count as the first positional argument (or default: 12).
- All agents must use `--base <milestone-pr-branch>` (the milestone PR's head branch, not the feature branch or main). This means feedback PRs target the milestone branch, so fixes accumulate on the milestone PR.
- Create worktrees from the milestone PR's branch: `.claude/worktree create swarm/<namespace>/task-<counter> origin/<milestone-pr-branch>`.
- Agents must NOT use `--merge` in `.claude/ship`. All PRs are created without auto-merging.
- **Merge override for "Address the feedback" tasks**: When the swarm encounters a feedback task referencing a PR that targets the milestone branch (i.e., it's a feedback PR, not the original milestone PR), merge that referenced PR into the milestone branch first (`gh pr merge <number> --squash`) so the next-level feedback agent has the code. Do NOT merge the original milestone PR (#`<milestone-pr-number>`, which targets the feature branch) — it must stay unmerged until Phase 4c.5.

Since milestones are added to TODO.md one at a time (and removed when executed), the only namespaced items in TODO.md during the sweep are feedback items for the current milestone. The swarm will process those and nothing else.

When the sweep says "final phase," proceed to step 4c.5.

#### 4c.5. Merge milestone PR into feature branch

This step runs ONLY after the per-milestone sweep completes cleanly (all reviews addressed, no pending feedback). This is the review-before-merge gate.

1. Merge any remaining unmerged feedback PRs into the milestone branch (squash merge, in order of PR number). These are feedback PRs that were approved but not yet merged:
   ```bash
   gh pr merge <feedback-pr-number> --squash
   ```
2. Merge the milestone PR into the feature branch:
   ```bash
   gh pr merge <milestone-pr-number> --squash
   ```
3. Fetch the updated feature branch:
   ```bash
   git fetch origin <feature-branch-name>
   ```

Proceed to step 4d.

#### 4d. Close the milestone and proceed

1. Set the milestone's GitHub issue status to "Done" and close it:
   ```bash
   .claude/gh-project set-status <issue-number> done
   gh issue close <issue-number>
   ```
2. Move to the next milestone and repeat from step 4a. Continue until all milestones are processed.

## Phase 5: Final Feature Branch Sweep

After all milestones are merged and their individual reviews are clean, run one final recursive sweep on the entire feature branch.

Read and follow `.claude/phases/sweep.md` with `--namespace <namespace>`. Unless `--auto` was passed, this is where the user-facing pause happens: **"All milestones complete. Run final sweep for review feedback?"**

This final sweep catches:
- Any cross-milestone issues that individual per-milestone sweeps missed
- Any remaining unreviewed PRs from any milestone

When the sweep says "back to the Swarm phase," run the swarm workflow (`.claude/commands/swarm.md`) with these modifications (note: these differ from Phase 4c because the final sweep operates on the feature branch, not a milestone branch):
- Pass `--namespace <namespace>` so only namespaced feedback items are processed.
- Pass the worker count as the first positional argument (or default: 12).
- All agents must use `--base <feature-branch-name>` (not main).
- Create worktrees from the feature branch: `.claude/worktree create swarm/<namespace>/task-<counter> origin/<feature-branch-name>`.
- Agents must NOT use `--merge` in `.claude/ship`. All PRs are created without auto-merging. The lead merges approved PRs after review.

When the sweep says "final phase," proceed to Phase 5.5.

## Phase 5.5: Merge Approved Final-Sweep PRs

This step runs ONLY after the final sweep completes cleanly (all reviews addressed, no pending feedback). It is the Phase 5 equivalent of Phase 4c.5 — without it, approved feedback PRs from the final sweep would remain unmerged, and their fixes would be missing from the final feature-branch PR.

1. Collect all feedback PRs that were created during the final sweep. These are PRs whose head branch starts with `swarm/<namespace>/` and whose base branch is the feature branch.

2. For each such PR, check if it is approved and unmerged:
   ```bash
   gh pr view <pr-number> --json state,mergedAt --jq '{state: .state, mergedAt: .mergedAt}'
   ```

3. Merge any approved but unmerged feedback PRs into the feature branch (squash merge, in order of PR number):
   ```bash
   gh pr merge <feedback-pr-number> --squash
   ```

4. If any PRs were merged, fetch the updated feature branch:
   ```bash
   git fetch origin <feature-branch-name>
   ```

Proceed to Phase 6.

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
- If an agent hits merge conflicts after another agent's PR landed, tell it to rebase against the appropriate branch: `git pull --rebase origin <milestone-pr-branch>` during per-milestone sweeps, or `git pull --rebase origin <feature-branch-name>` during the final sweep.
- **Do NOT merge milestone PRs into the feature branch until the per-milestone sweep completes cleanly.** The merge happens in Phase 4c.5 — never before.
- **Do NOT merge the final PR.** Only create it and present the link to the user.
