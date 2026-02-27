Plan a feature end-to-end, create GitHub issues on the project board, swarm-execute them in parallel, sweep for review feedback, address it, and report.

The user passed: `$ARGUMENTS`

If `$ARGUMENTS` is empty, stop and tell the user to provide a feature description. Example: `/blitz Add WebSocket transport for daemon IPC`.

## Parsing flags

Extract these flags from `$ARGUMENTS` before treating the remainder as the feature description:

- `--auto` — skip the pause between rounds (default: pause and ask before sweep)
- `--workers N` — parallel worker count for swarm phases (default: 12)
- `--skip-plan` — skip planning; use issues already in the "Ready" column of the GH project
- `--skip-reviews` — merge PRs immediately without waiting for review feedback (opt-in; default is to wait for reviews)

Everything after stripping flags is the **feature description**.

Read and follow `.claude/phases/namespace.md`.

Read and follow `.claude/phases/repo-gotchas.md`. Include these gotchas in every agent prompt.

## Phase 1: Project Setup

Read and follow `.claude/phases/project-setup.md`.

### Register active blitz

Register this blitz run in `.private/ACTIVE_BLITZ.md` so that standalone `/check-reviews` runs (without `--namespace`) will automatically skip PRs owned by this blitz. This prevents duplicate work when check-reviews runs as a periodic cronjob while this blitz is active.

1. Read `.private/ACTIVE_BLITZ.md` (create it if it doesn't exist). This file is gitignored.
2. Remove any existing line starting with `<namespace> ` (in case of a stale entry from a previous crashed run).
3. Append a new entry:
   ```bash
   echo "<namespace> blitz $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .private/ACTIVE_BLITZ.md
   ```

## Phase 2: Plan & Spec

Read and follow `.claude/phases/plan-and-spec.md`. For blitz mode, remove the `<EXTRA_EPIC_FIELDS>` placeholder entirely (no feature branch field).

## Phase 3: Populate TODO.md

Read and follow `.claude/phases/populate-todo.md`.

## Phase 4: Swarm

Read and follow the instructions in `.claude/commands/swarm.md` with these modifications:

- Pass the `--workers` count (or default: 12) as the first argument.
- Pass `--namespace <namespace>` to use the derived namespace for branch naming.
- **When `--skip-reviews` is set**: Agents use `--merge` in `.claude/ship` (current default swarm behavior). After each milestone task completes and its PR merges, update the corresponding GitHub issue immediately (see below).
- **When `--skip-reviews` is NOT set (default)**: Agents must NOT use `--merge` in `.claude/ship`. PRs are created but left unmerged. After the swarm completes, proceed to Phase 4.5 for review gates before merging. Do NOT update GitHub issues yet — that happens after merge in Phase 4.5.

For milestone tasks (skip this for non-milestone tasks like "Address the feedback on ..." items — those are PR-based and have no associated milestone issue), update the corresponding GitHub issue after its PR merges:

```bash
.claude/gh-project set-status <issue-number> done
gh issue close <issue-number>
```

- Everything else follows the standard swarm workflow (worktrees, conflict avoidance, TODO/DONE/UNREVIEWED tracking).

**When `--skip-reviews` is set**, skip Phase 4.5 and proceed directly to Phase 5.

## Phase 4.5: Review and Merge

**This phase only runs when `--skip-reviews` is NOT set (the default).**

After the swarm phase completes, all milestone PRs are open but unmerged. This phase runs a per-PR feedback loop on each one — addressing review feedback by pushing fixes directly to the PR branch — before merging to main.

### Determining aggregate review status from `check-pr-reviews` output

The `check-pr-reviews` script returns **per-reviewer** statuses at `codex.status` and `devin.status` — there is no top-level `status` field. Derive an aggregate status as follows:
- **approved**: Both `codex.status` and `devin.status` are `approved` (or `skipped` for Devin).
- **pending**: Either reviewer is `pending`.
- **rate_limited**: Either reviewer is `rate_limited` (and the other is not `changes_requested`).
- **changes_requested**: Either reviewer has `changes_requested` (and neither is `pending`).

### Handling stale `changes_requested` from old reviews

The `check-pr-reviews` script reports **cumulative** review status — it counts all reviews ever posted, not just unresolved ones. After fixes are pushed and threads are resolved, old reviews still exist in the GitHub API, so `check-pr-reviews` may still return `changes_requested` even though the feedback has been addressed. To avoid infinite loops, maintain a `last_fix_push_time` timestamp and use the `gh api` to check whether any reviews were posted **after** that timestamp before treating `changes_requested` as actionable.

### Per-PR feedback agent prompt

This template is used for feedback tasks during the per-PR review loop. Instead of creating a new PR, the agent pushes fixes directly to the PR branch.

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
Address the review feedback on PR #<pr-number> (<pr-url>):
<summary of changes requested>

## Workflow
1. Read the review comments on the PR to understand what changes are requested:
   ```bash
   gh api repos/{owner}/{repo}/pulls/<pr-number>/reviews --jq '.[-1].body'
   gh api repos/{owner}/{repo}/pulls/<pr-number>/comments --jq '.[] | {path: .path, body: .body, line: .line}'
   ```
2. Implement the requested fixes in your worktree.
3. Do NOT run tests, type-checking (tsc), or linting unless the task specifically requires it.
4. Commit and push directly to the PR branch:
   ```bash
   cd <worktree>
   git add -A
   git commit -m "<descriptive message about what feedback was addressed>"
   git push origin HEAD:<pr-branch>
   ```
5. Resolve the addressed review threads:
   ```bash
   .claude/gh-review resolve-threads <pr-number> "Addressed in direct push to <pr-branch>"
   ```
6. Do NOT create a new PR. Do NOT use .claude/ship.
7. Send a message to "lead" with:
   - A summary of what feedback was addressed
   - Which files were modified
   - Any issues or concerns

```

### For each unmerged PR (process sequentially)

Collect all unmerged PRs from `.private/UNREVIEWED_PRS.md` whose head branches start with `swarm/<namespace>/`. Process them one at a time (sequential order by PR number) since each merge to main may create conflicts for subsequent PRs.

For each PR, maintain an internal **cycle counter** starting at 0. The maximum number of feedback cycles is **3**.

#### Step 1: Fetch the PR branch

```bash
PR_BRANCH=$(gh pr view <pr-number> --json headRefName --jq '.headRefName')
git fetch origin $PR_BRANCH
```

#### Step 2: Check for reviews

Poll `.claude/check-pr-reviews <pr-number>` to get per-reviewer statuses. Derive the aggregate status (see above).

- If aggregate status is `pending`, wait 60 seconds and poll again.
- If aggregate status is `rate_limited`, wait 120 seconds and poll again.
- If aggregate status is `approved`, proceed to Step 6 (Merge).
- If aggregate status is `changes_requested`, proceed to Step 3.

#### Step 3: Check cycle limit

If the cycle counter has reached 3, log: `"Reached maximum feedback cycles (3) for PR #<pr-number>. Merging as-is."` and proceed to Step 6.

#### Step 4: Address the feedback

Increment the cycle counter by 1.

1. Read the review comments to understand what's requested.
2. Create a worktree from the PR branch:
   ```bash
   .claude/worktree create swarm/<namespace>/fix-<counter> origin/$PR_BRANCH
   ```
3. Spawn a `general-purpose` agent using the **per-PR feedback agent prompt** (see above). The agent pushes fixes directly to `$PR_BRANCH` instead of creating a new PR.
4. When the agent finishes, clean up the worktree:
   ```bash
   .claude/worktree remove swarm/<namespace>/fix-<counter> --delete-branch
   ```
5. Fetch the updated PR branch and get the latest commit SHA:
   ```bash
   git fetch origin $PR_BRANCH
   LATEST_COMMIT=$(git rev-parse origin/$PR_BRANCH)
   ```

#### Step 5: Re-request reviews and wait

After fixes are pushed, explicitly tag both reviewers by posting two separate comments on the PR:

```bash
gh pr comment <pr-number> --body "@codex review this PR again — the previous issues have been fixed in commit $LATEST_COMMIT"
gh pr comment <pr-number> --body "@devin review this PR again — the previous issues have been fixed in commit $LATEST_COMMIT"
```

Record the current UTC time as `last_fix_push_time` **after** posting the re-review comments (e.g., `date -u +%Y-%m-%dT%H:%M:%SZ`). This ensures the agent's own comment activity is excluded from the "new activity" check during polling.

Log: `"Re-requested reviews from Codex and Devin on PR #<pr-number> (cycle <cycle-counter>/3, commit $LATEST_COMMIT)."`

Wait for fresh reviews: Poll for **new** reviews posted after `last_fix_push_time`:
- Poll every 60 seconds for up to **3 minutes**.
- On each poll, run `.claude/check-pr-reviews <pr-number>` to get the full reviewer status (this catches Codex rate-limit responses in issue comments, which raw `pulls/<pr>/reviews` and `pulls/<pr>/comments` endpoints miss). Then check for new activity since `last_fix_push_time` using `gh api`:
  ```bash
  # Get full reviewer status including rate-limit detection from issue comments
  .claude/check-pr-reviews <pr-number>
  # Check for new review activity since fixes were pushed
  NEW_REVIEWS=$(gh api "repos/{owner}/{repo}/pulls/<pr-number>/reviews" \
    --jq '[.[] | select(.submitted_at > "'$last_fix_push_time'")] | length')
  NEW_COMMENTS=$(gh api "repos/{owner}/{repo}/pulls/<pr-number>/comments" \
    --jq '[.[] | select(.created_at > "'$last_fix_push_time'")] | length')
  NEW_ISSUE_COMMENTS=$(gh api "repos/{owner}/{repo}/issues/<pr-number>/comments" \
    --jq '[.[] | select(.created_at > "'$last_fix_push_time'")] | length')
  ```
- If new activity exists (any of `NEW_REVIEWS`, `NEW_COMMENTS`, or `NEW_ISSUE_COMMENTS` > 0), derive the aggregate status from the `check-pr-reviews` output:
  - If aggregate status is `approved`, proceed to Step 6.
  - If aggregate status is `changes_requested`, return to Step 3 (which checks the cycle limit).
  - If aggregate status is `rate_limited`, continue polling (the rate limit response counts as activity but is not actionable yet).
  - If aggregate status is `pending`, continue polling.
- If **3 minutes** pass with no new reviews, proceed to Step 6. Log: `"No new reviews within 3 minutes after fixes pushed. Proceeding to merge."`

#### Step 6: Merge to main

```bash
gh pr merge <pr-number> --squash
```

After merging, update the corresponding GitHub issue for milestone tasks (skip for non-milestone tasks):

```bash
.claude/gh-project set-status <issue-number> done
gh issue close <issue-number>
```

Pull latest main for subsequent PR merges:

```bash
git fetch origin main
```

If the next PR in the queue has conflicts with the updated main, rebase its branch before proceeding. This is critical because approved PRs skip the feedback loop and go straight to merge — without an explicit rebase step, a conflicted-but-approved PR would fail to merge and halt the blitz sequence.

```bash
git fetch origin <next-pr-branch>
# Check for conflicts
if ! git merge-tree --write-tree origin/<next-pr-branch> origin/main > /dev/null 2>&1; then
  # Rebase the PR branch onto latest main
  NEXT_BRANCH=<next-pr-branch>
  REBASE_DIR=$(mktemp -d)
  git worktree add "$REBASE_DIR" "origin/$NEXT_BRANCH"
  cd "$REBASE_DIR"
  git checkout -B "$NEXT_BRANCH" "origin/$NEXT_BRANCH"
  git pull --rebase origin main
  git push origin "$NEXT_BRANCH" --force-with-lease
  cd -
  git worktree remove "$REBASE_DIR" --force
  git fetch origin "$NEXT_BRANCH"

  # Verify the rebase resolved conflicts; if it failed, log and continue
  # (the per-PR feedback loop or manual intervention will handle it)
  if ! git merge-tree --write-tree "origin/$NEXT_BRANCH" origin/main > /dev/null 2>&1; then
    echo "Warning: Rebase of $NEXT_BRANCH onto main still has conflicts after rebase attempt. Manual intervention may be needed."
  fi
fi
```

#### Step 7: Report

Report to the user: show the PR, its review status, how many feedback cycles were needed, and the merge result.

After all PRs are merged, proceed to Phase 5.

## Phase 5: Recursive Sweep

**Update the blitz heartbeat** at the start of each sweep loop iteration to prevent the entry from going stale. Replace the line starting with `<namespace> ` in `.private/ACTIVE_BLITZ.md` with a fresh timestamp:
```bash
# Read, filter out old entry, append fresh entry
grep -v "^<namespace> " .private/ACTIVE_BLITZ.md > .private/ACTIVE_BLITZ.md.tmp 2>/dev/null || true
echo "<namespace> blitz $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .private/ACTIVE_BLITZ.md.tmp
mv .private/ACTIVE_BLITZ.md.tmp .private/ACTIVE_BLITZ.md
```

Read and follow `.claude/phases/sweep.md`. When it says "back to the Swarm phase", return to Phase 4 above (with the same `--skip-reviews` behavior). When it says "final phase", proceed to Phase 6.

This phase runs a recursive loop: check reviews → swarm to address feedback → review and merge feedback PRs → check reviews on the merged feedback PRs → repeat. PRs created to address feedback are themselves tracked in UNREVIEWED_PRS.md and must be reviewed before the blitz is considered done. The blitz only exits the sweep when there are no namespaced TODO items AND no namespaced PRs pending review.

**When `--skip-reviews` is NOT set (default)**: After each swarm pass in the sweep, run Phase 4.5 (Review and Merge) on the newly created feedback PRs before continuing the sweep loop.

**When `--skip-reviews` is set**: Feedback PRs are merged immediately by swarm agents (current behavior). The sweep continues as before.

## Phase 6: Report

### Deregister active blitz

Remove this blitz's entry from `.private/ACTIVE_BLITZ.md`:
```bash
grep -v "^<namespace> " .private/ACTIVE_BLITZ.md > .private/ACTIVE_BLITZ.md.tmp 2>/dev/null || true
mv .private/ACTIVE_BLITZ.md.tmp .private/ACTIVE_BLITZ.md
```
If the file is now empty (only blank lines), delete it: `rm -f .private/ACTIVE_BLITZ.md`

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

Read and follow `.claude/phases/blitz-important.md`. Additionally:
- If an agent hits merge conflicts, tell it to rebase: `git pull --rebase origin main`.
