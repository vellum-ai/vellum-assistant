Execute a multi-PR rollout plan one PR at a time, pausing after each for human review.

The user passed: `$ARGUMENTS`

If `$ARGUMENTS` is empty, stop and tell the user to provide the plan filename. Example: `/safe-execute-plan BROWSER_PLAN.md`.

## Repo-specific gotchas

- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.

## Steps

### 1. Read the plan

Sanitize `$ARGUMENTS` by stripping any path separators (use `basename -- "$ARGUMENTS"`). Then read `.private/plans/<sanitized name>`. If the file doesn't exist, stop and tell the user.

Parse the plan to identify the ordered list of PRs. Plans typically have numbered PR sections (e.g. "## PR 1", "## PR 2") each describing: branch name, title, scope, files to modify, implementation steps, tests to run, and acceptance criteria.

Derive a **plan slug** from the filename (e.g. `BROWSER_PLAN.md` → `browser-plan`). This is used to namespace state and worktrees.

### 2. Check for existing state

Read `.private/safe-plan-state/<plan-slug>.md` if it exists. If it has an active PR, tell the user:

> This plan already has an active PR: <PR link>
> Run `/safe-check-review <plan file>` to check for feedback, or `/resume-plan <plan file>` to merge and continue.

Then stop.

### 3. Determine starting point

Check which PRs have already been completed. Look at:
- The git log for commits/PRs that match earlier PR titles or branch names from the plan.
- Whether the files/changes described in earlier PRs already exist in the codebase.

Skip any PRs that are already done. Tell the user which PRs you're skipping and why.

### 4. Implement the next PR

#### 4a. Create worktree

Derive a branch name from the plan's PR section (or from the PR title). Fetch latest main and create a worktree:

```bash
git fetch origin main
.claude/worktree create safe-plan/<plan-slug>/<pr-slug> origin/main
```

ALL work happens in the worktree — do NOT modify files in the main repo.

#### 4b. Implement

Read the PR section carefully. Implement all the changes described:
- Create/modify the listed files according to the steps.
- Follow the project conventions described in AGENTS.md.

#### 4c. Validate

**Do NOT run tests, type-checking (`tsc`), or linting unless the plan's PR section explicitly specifies validation steps.** These steps are slow and rarely catch issues for well-scoped changes.

#### 4d. Ship (do NOT merge)

**Run from the worktree root** (not `assistant/` or the main repo):

```bash
cd <worktree> && .claude/ship \
  --commit-msg "<commit message>" \
  --title "<title from plan>" \
  --body "## Summary
<1-3 bullet points>

Part of plan: <plan filename> (PR <X> of <total>)

<details>
<summary>Plan: <plan filename></summary>

<contents of .private/plans/<plan file>>

</details>

🤖 Generated with [Claude Code](https://claude.com/claude-code)" \
  --base main \
  --track-unreviewed
```

Record the PR number and head branch name for the review loop:

```bash
PR_NUMBER=<number printed by .claude/ship>
PR_BRANCH=$(gh pr view $PR_NUMBER --json headRefName --jq '.headRefName')
```

### 5. Human Attention Comment (optional)

If the PR contains areas that genuinely warrant focused human review, leave a comment highlighting them (see "Human Attention Comments on PRs" in AGENTS.md). Skip this for routine, low-risk changes.

### 6. Automated review feedback loop

After shipping, trigger reviews from Codex and Devin, then automatically address their feedback. This loop runs up to **3 cycles**.

Maintain an internal **cycle counter** starting at 0, a **fix counter** for worktree naming (e.g., `fix-1`, `fix-2`, ...), and a `last_fix_push_time` timestamp.

#### 6a. Trigger initial reviews

Post two separate comments on the PR to invoke Codex and Devin:

```bash
gh pr comment $PR_NUMBER --body "@codex review"
gh pr comment $PR_NUMBER --body "@devin review"
```

Log: `"Requested reviews from Codex and Devin on PR #$PR_NUMBER."`

#### 6b. Feedback loop

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
   - If aggregate status is `approved`, proceed to Step 7 (done).
   - If aggregate status is `changes_requested`, proceed to step 2.

2. **Check cycle limit**: If the cycle counter has reached 3, log: `"Reached maximum feedback cycles (3) for PR #$PR_NUMBER. Proceeding."` and proceed to Step 7.

3. **Address the feedback**: Increment the cycle counter by 1.
   a. Read the review comments to understand what's requested.
   b. Create a worktree from the PR branch:
      ```bash
      .claude/worktree create safe-plan/<plan-slug>/<pr-slug>-fix-<counter> origin/$PR_BRANCH
      ```
   c. Spawn a `general-purpose` agent using the **feedback agent prompt** (see below). The agent pushes fixes directly to `$PR_BRANCH` instead of creating a new PR.
   d. When the agent finishes, clean up the worktree:
      ```bash
      .claude/worktree remove safe-plan/<plan-slug>/<pr-slug>-fix-<counter> --delete-branch
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

5. **Wait for fresh reviews**: After fixes are pushed, poll for **new** reviewer activity from Codex and Devin posted after `last_fix_push_time`. Do NOT use `check-pr-reviews` cumulative statuses to determine whether reviewers have responded — old reviews persist in the GitHub API and will make cumulative status checks pass immediately on subsequent cycles.
   - Poll every 60 seconds for up to **10 minutes**.
   - On each poll, collect the **login names** of reviewer bots that have posted new activity (reviews, inline comments, issue comments, or reactions) after `last_fix_push_time`:
     ```bash
     # Get reviewer bot logins with new reviews after last_fix_push_time
     review_bot_logins=$(gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/reviews" \
       --jq '[.[] | select(.submitted_at > "'$last_fix_push_time'" and (.user.login == "chatgpt-codex-connector[bot]" or .user.login == "devin-ai-integration[bot]"))] | [.[].user.login] | unique | .[]')
     # Get reviewer bot logins with new inline comments after last_fix_push_time
     comment_bot_logins=$(gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/comments" \
       --jq '[.[] | select(.created_at > "'$last_fix_push_time'" and (.user.login == "chatgpt-codex-connector[bot]" or .user.login == "devin-ai-integration[bot]"))] | [.[].user.login] | unique | .[]')
     # Get reviewer bot logins with new issue comments after last_fix_push_time
     issue_comment_bot_logins=$(gh api "repos/{owner}/{repo}/issues/$PR_NUMBER/comments" \
       --jq '[.[] | select(.created_at > "'$last_fix_push_time'" and (.user.login == "chatgpt-codex-connector[bot]" or .user.login == "devin-ai-integration[bot]"))] | [.[].user.login] | unique | .[]')
     # Get reviewer bot logins with new reactions after last_fix_push_time (e.g., Codex +1 approval)
     reaction_bot_logins=$(gh api "repos/{owner}/{repo}/issues/$PR_NUMBER/reactions" \
       --jq '[.[] | select(.created_at > "'$last_fix_push_time'" and (.user.login == "chatgpt-codex-connector[bot]" or .user.login == "devin-ai-integration[bot]"))] | [.[].user.login] | unique | .[]')
     # Union all logins across endpoints and count unique bots
     all_responded_bots=$(echo -e "$review_bot_logins\n$comment_bot_logins\n$issue_comment_bot_logins\n$reaction_bot_logins" | sort -u | grep -c .)
     ```
     A reviewer bot counts as "responded" if its login appears in any of the four queries above. Both bots must have posted something new to consider the poll complete.
   - If `all_responded_bots` is **>= 2** (both reviewer bots have posted new activity after `last_fix_push_time`), run `.claude/check-pr-reviews $PR_NUMBER` and derive the aggregate status:
     - If aggregate status is `approved`, proceed to Step 7.
     - If aggregate status is `changes_requested`, return to step 2 (which checks the cycle limit).
     - If aggregate status is `pending` or `rate_limited`, continue polling.
   - If `all_responded_bots` is **< 2**, **continue polling** — do not exit the loop. Old cumulative statuses from `check-pr-reviews` are unreliable after fixes have been pushed.
   - If **10 minutes** pass without both reviewer bots posting new activity, proceed to Step 7. Log: `"Timed out after 10 minutes waiting for reviewer responses. Proceeding with pending reviews."`

Repeat steps 1-5 until the exit condition: either `approved` aggregate status, both reviewers have posted fresh activity, 10-minute timeout after a fix push, or the cycle counter has reached 3.

#### Feedback agent prompt

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

### 7. Save state

```bash
mkdir -p .private/safe-plan-state
```

Write `.private/safe-plan-state/<plan-slug>.md` with this format:

```markdown
# Safe Plan State

- **Plan**: <plan filename>
- **Current PR**: <X> of <total>
- **PR URL**: <github PR URL>
- **PR Number**: <number>
- **Branch**: <branch name>
- **Worktree**: <absolute path to worktree>
- **Review cycles completed**: <cycle-counter>/3
```

### 8. Notify the user and stop

Tell the user:

> **PR <X> of <total> is ready for review:** <PR link>
>
> - <brief summary of what was implemented>
> - Files changed: <list>
> - **Review cycles completed:** <cycle-counter>/3
> - **Final review status:** <approved / max cycles reached / timed out waiting for reviews>
>
> **Next steps:**
> - `/resume-plan <plan file>` — merge this PR and continue to the next one

Then **stop**. Do NOT continue to the next PR.

## Important

- .private/UNREVIEWED_PRS.md is written to by other processes. Read before writing, verify after writing. This file is gitignored.
- .private/safe-plan-state/ is gitignored.
- Multiple plans can run concurrently — each has its own state file and worktree namespace.
