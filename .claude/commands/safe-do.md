Implement the requested changes in an isolated worktree, open a PR for review, and iterate on feedback from Codex and Devin up to 3 times before stopping.

The user passed: `$ARGUMENTS`

If `$ARGUMENTS` is empty, stop and tell the user to provide a description of what to do. Example: `/safe-do Add input validation to the login form`.

## Repo-specific gotchas

- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- **CI**: Do NOT wait for CI checks to pass before merging. Merge immediately.

## Steps

### 1. Create worktree

Derive a short branch name slug from the description (e.g. `safe-do/add-login-validation`).

Fetch the latest main and create the worktree based on `origin/main` so the branch doesn't include unrelated commits:

```bash
git fetch origin main
.claude/worktree create safe-do/<slug> origin/main
```

Remember the worktree path printed by the script. ALL work happens in the worktree — do NOT modify files in the main repo.

### 2. Implement the changes

Working entirely inside the worktree directory, implement what was requested. Explore the codebase and make changes.

**Do NOT run tests, type-checking (`tsc`), or linting unless the task specifically requires it** (e.g., "fix the type errors", "make the tests pass"). These steps are slow and rarely catch issues for well-scoped changes.

### 3. Ship (do NOT merge)

Review what changed, draft a commit message and PR title, then ship.

**Run from the worktree root** (not `assistant/` or the main repo):

```bash
cd <worktree> && .claude/ship \
  --commit-msg "<commit message>" \
  --title "<PR title>" \
  --body "## Summary
<1-3 bullet points>

## Original prompt
$ARGUMENTS

🤖 Generated with [Claude Code](https://claude.com/claude-code)" \
  --base main \
  --track-unreviewed
```

Record the PR number and the head branch name for later steps:

```bash
PR_NUMBER=<number printed by .claude/ship>
PR_BRANCH=$(gh pr view $PR_NUMBER --json headRefName --jq '.headRefName')
```

### 4. Human Attention Comment (optional)

If the PR contains areas that genuinely warrant focused human review, leave a comment highlighting them (see "Human Attention Comments on PRs" in AGENTS.md). Skip this step for routine, low-risk changes.

### 5. Review feedback loop

After shipping, trigger reviews from Codex and Devin, then iterate on their feedback. This loop runs up to **3 cycles**. Each cycle: wait for reviews, address any feedback by pushing fixes directly to the PR branch, re-tag reviewers, and repeat.

Maintain an internal **cycle counter** starting at 0, a **fix counter** for worktree naming (e.g., `fix-1`, `fix-2`, ...), and a `last_fix_push_time` timestamp.

#### 5a. Trigger initial reviews

Post two separate comments on the PR to invoke Codex and Devin:

```bash
gh pr comment $PR_NUMBER --body "@codex review"
gh pr comment $PR_NUMBER --body "@devin review"
```

Log: `"Requested reviews from Codex and Devin on PR #$PR_NUMBER."`

#### 5b. Feedback loop

Repeat the following until the exit condition is met:

**Determining aggregate review status from `check-pr-reviews` output:**

The `check-pr-reviews` script returns **per-reviewer** statuses at `codex.status` and `devin.status` — there is no top-level `status` field. Derive an aggregate status as follows:
- **approved**: Both `codex.status` and `devin.status` are `approved` (or `skipped` for Devin).
- **pending**: Either reviewer is `pending`.
- **rate_limited**: Either reviewer is `rate_limited` (and the other is not `changes_requested`).
- **changes_requested**: Either reviewer has `changes_requested` (and neither is `pending`).

Use this aggregate status in the feedback loop below.

**Handling stale `changes_requested` from old reviews:**

The `check-pr-reviews` script reports **cumulative** review status — it counts all reviews ever posted, not just unresolved ones. After fixes are pushed and threads are resolved, old reviews still exist in the GitHub API, so `check-pr-reviews` may still return `changes_requested` even though the feedback has been addressed. To avoid infinite loops, use the `last_fix_push_time` timestamp and the `gh api` to check whether any reviews were posted **after** that timestamp before treating `changes_requested` as actionable.

1. **Check for reviews**: Poll `.claude/check-pr-reviews $PR_NUMBER` to get per-reviewer statuses. Derive the aggregate status (see above).
   - If aggregate status is `pending`, wait 60 seconds and poll again.
   - If aggregate status is `rate_limited`, wait 120 seconds and poll again.
   - If aggregate status is `approved`, proceed to Step 6 (done).
   - If aggregate status is `changes_requested`, proceed to step 2.

2. **Check cycle limit**: If the cycle counter has reached 3, log: `"Reached maximum feedback cycles (3) for PR #$PR_NUMBER. Stopping."` and proceed to Step 6.

3. **Address the feedback**: Increment the cycle counter by 1.
   a. Read the review comments to understand what's requested.
   b. Create a worktree from the PR branch:
      ```bash
      .claude/worktree create safe-do/<slug>-fix-<counter> origin/$PR_BRANCH
      ```
   c. Spawn a `general-purpose` agent using the **feedback agent prompt** (see below). The agent pushes fixes directly to `$PR_BRANCH` instead of creating a new PR.
   d. When the agent finishes, clean up the worktree:
      ```bash
      .claude/worktree remove safe-do/<slug>-fix-<counter> --delete-branch
      ```
   e. Fetch the updated PR branch and get the latest commit SHA:
      ```bash
      git fetch origin $PR_BRANCH
      LATEST_COMMIT=$(git rev-parse origin/$PR_BRANCH)
      ```
   f. Record the current UTC time as `last_fix_push_time` (e.g., `date -u +%Y-%m-%dT%H:%M:%SZ`).

4. **Re-request reviews**: After fixes are pushed, explicitly tag both reviewers to re-request their review by posting two separate comments on the PR:
   ```bash
   gh pr comment $PR_NUMBER --body "@codex review this PR again — the previous issues have been fixed in commit $LATEST_COMMIT"
   gh pr comment $PR_NUMBER --body "@devin review this PR again — the previous issues have been fixed in commit $LATEST_COMMIT"
   ```
   Log: `"Re-requested reviews from Codex and Devin on PR #$PR_NUMBER (cycle <cycle-counter>/3, commit $LATEST_COMMIT)."`

5. **Wait for fresh reviews**: After fixes are pushed, poll for **new** reviews posted after `last_fix_push_time`:
   - Poll every 60 seconds for up to **3 minutes**.
   - On each poll, use `gh api` to check for reviews and inline comments posted after `last_fix_push_time`:
     ```bash
     gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/reviews" \
       --jq '[.[] | select(.submitted_at > "'$last_fix_push_time'")] | length'
     gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/comments" \
       --jq '[.[] | select(.created_at > "'$last_fix_push_time'")] | length'
     ```
   - If new reviews exist, run `.claude/check-pr-reviews $PR_NUMBER` and derive the aggregate status:
     - If aggregate status is `approved`, proceed to Step 6.
     - If aggregate status is `changes_requested`, return to step 2 (which checks the cycle limit).
     - If aggregate status is `pending` or `rate_limited`, continue polling.
   - If **3 minutes** pass with no new reviews (zero new reviews/comments since `last_fix_push_time`), proceed to Step 6. Log: `"No new reviews within 3 minutes after fixes pushed. Proceeding."`

Repeat steps 1-5 until the exit condition: either `approved` aggregate status, 3-minute timeout with no new reviews after a fix push, or the cycle counter has reached 3.

#### Feedback agent prompt

This template is used for feedback tasks during the review loop (Step 5b). Instead of creating a new PR, the agent pushes fixes directly to the PR branch.

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

### 6. Notify the user and stop

Tell the user:

> **PR is ready for review:** <PR link>
>
> - <brief summary of what was implemented>
> - Files changed: <list>
> - Worktree: `<worktree path>` (kept for addressing further feedback)
> - **Review cycles completed:** <cycle-counter>/3
> - **Final review status:** <approved / max cycles reached / timed out waiting for reviews>
>
> **Next steps:**
> - Review the PR on GitHub
> - To merge: `gh pr merge <N> --squash`
> - To clean up the worktree after merging: `.claude/worktree remove safe-do/<slug> --delete-branch`
> - To pull main after merging: `git checkout main && git pull origin main`

Then **stop**. Do NOT merge the PR.

## Important

- .private/UNREVIEWED_PRS.md is written to by other processes. Read before writing, verify after writing.
- The worktree is intentionally left in place so further feedback can be addressed without recreating it.
