Plan a feature end-to-end, create GitHub issues on the project board, execute milestones sequentially with per-milestone review gates onto a feature branch, and present the final PR for manual review.

Unlike `/blitz`, this command does NOT merge directly to main. Instead, it creates a **feature branch** and processes milestones **one at a time** — each milestone is executed, then review feedback is addressed by pushing fixes directly to the milestone PR branch until all feedback is exhausted. Only after reviews are fully clean is the milestone PR merged into the feature branch. After all milestones are complete, a final sweep runs on the entire feature branch. Then a PR from the feature branch into main is created, and a holistic Codex review is triggered. Codex feedback is iterated on until approved, CI is verified stable, and only then are you prompted to merge.

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

3. Store the feature branch name for later phases. Milestone agents will use `--base <feature-branch-name>`. Per-milestone feedback agents will push directly to the milestone PR branch (see Phase 4c).

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

**CRITICAL: Review-before-merge policy.** Milestone PRs must NOT be merged into the feature branch until all reviews are addressed and there is no pending feedback. The merge happens only after the per-milestone feedback loop completes cleanly. This is the defining guarantee of safe-blitz — if a PR is merged before reviews are clean, the review gate is meaningless.

Process milestones **one at a time** (sequentially). For each milestone, execute it, run a direct feedback loop to address all review feedback by pushing fixes to the milestone branch, and only THEN merge the milestone PR into the feature branch. This ensures each milestone is fully reviewed before its code lands on the feature branch.

The safe-blitz only considers a milestone "done" when its PR has been fully reviewed with no remaining change requests (all feedback addressed via direct pushes to the milestone branch), AND the milestone PR has been merged into the feature branch.

### Agent prompt template

The following prompt template is used for milestone tasks and final sweep feedback tasks. The `<base-branch>` placeholder is filled in by the lead when spawning the agent:
- For **milestone tasks**: `<base-branch>` = `<feature-branch-name>`
- For **feedback tasks during final sweep** (Phase 5): `<base-branch>` = `<feature-branch-name>`

Per-milestone feedback uses a different workflow — see "Per-milestone feedback agent prompt" below.

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

### Per-milestone feedback agent prompt

This template is used for feedback tasks during the per-milestone review loop (Phase 4c). Instead of creating a new PR, the agent pushes fixes directly to the milestone PR branch.

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
Address the review feedback on PR #<milestone-pr-number> (<milestone-pr-url>):
<summary of changes requested>

## Workflow
1. Read the review comments on the milestone PR to understand what changes are requested:
   ```bash
   gh api repos/{owner}/{repo}/pulls/<milestone-pr-number>/reviews --jq '.[-1].body'
   gh api repos/{owner}/{repo}/pulls/<milestone-pr-number>/comments --jq '.[] | {path: .path, body: .body, line: .line}'
   ```
2. Implement the requested fixes in your worktree.
3. Do NOT run tests, type-checking (tsc), or linting unless the task specifically requires it.
4. Commit and push directly to the milestone PR branch:
   ```bash
   cd <worktree>
   git add -A
   git commit -m "<descriptive message about what feedback was addressed>"
   git push origin HEAD:<milestone-pr-branch>
   ```
5. Resolve the addressed review threads:
   ```bash
   .claude/gh-review resolve-threads <milestone-pr-number> "Addressed in direct push to <milestone-pr-branch>"
   ```
6. Do NOT create a new PR. Do NOT use .claude/ship.
7. Send a message to "lead" with:
   - A summary of what feedback was addressed
   - Which files were modified
   - Any issues or concerns

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

#### 4c. Per-milestone feedback loop

Instead of using the full sweep+swarm machinery (which creates new PRs), per-milestone feedback is handled by pushing fixes directly to the milestone PR branch. This is faster and avoids the overhead of creating, reviewing, and merging intermediate feedback PRs.

Maintain an internal counter for worktree naming (e.g., `fix-1`, `fix-2`, ...) and a **cycle counter** starting at 0. The maximum number of feedback cycles is **3** — after 3 full rounds of addressing feedback, merge the milestone PR regardless.

**Feedback loop:**

1. **Check for reviews**: Poll `.claude/check-pr-reviews <milestone-pr-number>` to check review status.
   - If status is `pending`, wait 60 seconds and poll again.
   - If status is `rate_limited`, wait 120 seconds and poll again.
   - If status is `approved`, proceed to Phase 4c.5.
   - If status is `changes_requested`, proceed to step 2.

2. **Check cycle limit**: If the cycle counter has reached 3, log: `"Reached maximum feedback cycles (3) for milestone PR #<milestone-pr-number>. Merging as-is."` and proceed to Phase 4c.5.

3. **Address the feedback**: Increment the cycle counter by 1.
   a. Read the review comments to understand what's requested.
   b. Create a worktree from the milestone PR branch:
      ```bash
      .claude/worktree create swarm/<namespace>/fix-<counter> origin/<milestone-pr-branch>
      ```
   c. Spawn a `general-purpose` agent using the **per-milestone feedback agent prompt** (see above). The agent pushes fixes directly to `<milestone-pr-branch>` instead of creating a new PR.
   d. When the agent finishes, clean up the worktree:
      ```bash
      .claude/worktree remove swarm/<namespace>/fix-<counter> --delete-branch
      ```
   e. Fetch the updated milestone branch and get the latest commit SHA:
      ```bash
      git fetch origin <milestone-pr-branch>
      LATEST_COMMIT=$(git rev-parse origin/<milestone-pr-branch>)
      ```

4. **Re-request reviews**: After fixes are pushed, explicitly tag both reviewers to re-request their review by posting two separate comments on the milestone PR:
   ```bash
   gh pr comment <milestone-pr-number> --body "@codex review this PR again — the previous issues have been fixed in commit $LATEST_COMMIT"
   gh pr comment <milestone-pr-number> --body "@devin review this PR again — the previous issues have been fixed in commit $LATEST_COMMIT"
   ```
   Log: `"Re-requested reviews from Codex and Devin on milestone PR #<milestone-pr-number> (cycle <cycle-counter>/3, commit $LATEST_COMMIT)."`

5. **Wait for fresh reviews**: Poll for new reviews on the milestone PR:
   - Poll `.claude/check-pr-reviews <milestone-pr-number>` every 60 seconds.
   - If status is `pending`, wait 60 seconds and poll again.
   - If status is `rate_limited`, wait 120 seconds and poll again.
   - If status is `changes_requested`, return to step 2 (which checks the cycle limit).
   - If status is `approved`, proceed to Phase 4c.5.

Repeat steps 1-5 until the exit condition: either `approved` status, or the cycle counter has reached 3.

#### 4c.5. Merge milestone PR into feature branch

This step runs after the per-milestone feedback loop exits — either because all reviews are approved, or the maximum feedback cycle limit (3) was reached. This is the review-before-merge gate.

Since feedback was pushed directly to the milestone branch (no intermediate feedback PRs to merge), simply merge the milestone PR:

1. Merge the milestone PR into the feature branch:
   ```bash
   gh pr merge <milestone-pr-number> --squash
   ```
2. Fetch the updated feature branch:
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
- Any cross-milestone issues that individual per-milestone feedback loops missed
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

3. Record the final PR number and URL for Phase 7.

## Phase 7: Holistic Codex Review

After the final PR is created, trigger a holistic review by Codex to catch any cross-milestone issues, architectural concerns, or integration problems that per-milestone reviews may have missed.

### 7a. Trigger the review

Leave a comment on the final PR to invoke Codex:

```bash
gh pr comment <final-pr-number> --body "@codex review"
```

Log: `"Triggered holistic Codex review on final PR #<final-pr-number>. Waiting for review..."`

### 7b. Codex review feedback loop

Repeat the following until the exit condition is met:

1. **Wait for Codex to post its review.** Poll the PR review status using `.claude/check-pr-reviews`:

   ```bash
   .claude/check-pr-reviews <final-pr-number>
   ```

   - If Codex status is `pending`, wait 60 seconds and poll again. Log: `"Waiting for Codex review on final PR #<final-pr-number>..."`
   - If Codex status is `rate_limited`, wait 120 seconds and poll again.
   - If Codex status is `approved`, proceed to the exit condition check (step 7c).
   - If Codex status is `changes_requested`, proceed to step 2.

2. **Address Codex feedback.** When Codex requests changes:

   a. Read the review comments on the final PR to understand the requested changes:
      ```bash
      gh api repos/{owner}/{repo}/pulls/<final-pr-number>/reviews --jq '.[-1].body'
      gh api repos/{owner}/{repo}/pulls/<final-pr-number>/comments --jq '.[] | select(.user.login | test("codex")) | {path: .path, body: .body, line: .line}'
      ```

   b. For each piece of actionable feedback, add a namespaced TODO item to `.private/TODO.md`:
      ```
      - [<namespace>] Address the feedback on <final-pr-url>: <summary of change requested>
      ```

   c. Run the swarm workflow (`.claude/commands/swarm.md`) with these modifications:
      - Pass `--namespace <namespace>` so only namespaced feedback items are processed.
      - Pass the worker count as the first positional argument (or default: 12).
      - All agents must use `--base <feature-branch-name>` (not main).
      - Create worktrees from the feature branch: `.claude/worktree create swarm/<namespace>/task-<counter> origin/<feature-branch-name>`.
      - Agents must NOT use `--merge` in `.claude/ship`. All PRs are created without auto-merging.

   d. After the swarm completes, merge any approved feedback PRs into the feature branch (squash merge, in order of PR number):
      ```bash
      gh pr merge <feedback-pr-number> --squash
      ```

   e. Fetch the updated feature branch:
      ```bash
      git fetch origin <feature-branch-name>
      ```

   f. Resolve the addressed review threads on the final PR:
      ```bash
      .claude/gh-review resolve-threads <final-pr-number> "Addressed in feedback PRs"
      ```

   g. Re-trigger Codex review by commenting on the final PR again:
      ```bash
      gh pr comment <final-pr-number> --body "@codex review"
      ```

   h. Return to step 1 of this loop.

### 7c. Verify CI is stable

Once Codex has approved (or there are no remaining change requests), verify that CI checks are passing on the final PR:

```bash
gh pr checks <final-pr-number> --json name,state,conclusion --jq '.[] | {name: .name, state: .state, conclusion: .conclusion}'
```

- If any required checks are failing, investigate and address the failures using the same swarm workflow as step 7b (create TODO items, swarm, merge fixes, re-check).
- If checks are still running, wait 60 seconds and poll again. Log: `"CI checks still running on final PR #<final-pr-number>..."`
- If all checks pass (or there are no required checks), proceed to Phase 8.

## Phase 8: Final Summary & Merge Prompt

1. If the final PR warrants focused human review, leave a Human Attention Comment (see "Human Attention Comments on PRs" in AGENTS.md). Skip for routine changes.

2. Get the project board URL:

```bash
gh project view "$GH_PROJECT_NUMBER" --owner "$GH_PROJECT_OWNER" --format json | jq -r '.url'
```

3. Print the final summary:

```
## Safe Blitz Complete

**Feature:** <feature description>
**Project issue:** #<number> (<link>)
**Project board:** <board-url>
**Feature branch:** `<feature-branch-name>`

### Final PR (reviewed by Codex, CI stable):
<PR URL>

| #   | Milestone                          | Issue | PR   | Status              |
| --- | ---------------------------------- | ----- | ---- | ------------------- |
| M1  | <title>                            | #10   | #15  | merged -> feature    |
| M2  | <title>                            | #11   | #16  | merged -> feature    |
| M3  | <title>                            | #12   | #17  | merged -> feature    |

**Feedback PRs:** <count, if any>
**Codex review:** Approved
**CI status:** All checks passing
```

4. **Ask the user if they are ready to merge:**

   Pause and ask: **"All milestones complete, Codex review approved, and CI is stable. Ready to merge the final PR into main?"**

   - If the user confirms, merge the final PR:
     ```bash
     gh pr merge <final-pr-number> --squash
     ```
     Then update the project issue status to "Done" and close it:
     ```bash
     .claude/gh-project set-status <project-issue-number> done
     gh issue close <project-issue-number>
     ```
     Print: `"Final PR merged and project issue closed. Safe blitz complete!"`

   - If the user declines, print: `"Final PR is open and waiting for your review at <PR URL>. Run /safe-blitz-done when ready to merge."`

## Important

Read and follow `.claude/phases/blitz-important.md`. Additionally:
- If an agent hits merge conflicts after another agent's PR landed, tell it to rebase against the appropriate branch: `git pull --rebase origin <milestone-pr-branch>` during per-milestone feedback loops, or `git pull --rebase origin <feature-branch-name>` during the final sweep.
- **Do NOT merge milestone PRs into the feature branch until the per-milestone feedback loop completes cleanly.** The merge happens in Phase 4c.5 — never before.
- **Do NOT merge the final PR until Phase 8** — after Codex holistic review is approved and CI is stable, and only with explicit user confirmation.
