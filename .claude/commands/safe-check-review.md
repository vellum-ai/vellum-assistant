Check the active plan PR for review feedback and address it.

The user passed: `$ARGUMENTS`

If `$ARGUMENTS` is empty, check `.private/safe-plan-state/` for state files. If exactly one exists, use that plan. If multiple exist, list them and ask the user to specify. If none exist, tell the user:

> No active plan PR. Run `/safe-execute-plan <plan file>` to start.

Then stop.

## Steps

### 1. Read state

Sanitize `$ARGUMENTS` by stripping any path separators (use `basename -- "$ARGUMENTS"`). Derive the **plan slug** from the filename (e.g. `BROWSER_PLAN.md` → `browser-plan`).

Read `.private/safe-plan-state/<plan-slug>.md`. If it doesn't exist or has no active PR, tell the user:

> No active PR for this plan. Run `/safe-execute-plan <plan file>` to start.

Then stop.

Record from the state file: **PR number**, **PR branch**, **worktree path**.

### 2. Fetch review data

Using the PR number from the state file, run these commands in parallel:

1. **Reviews and comments:** `gh pr view <number> --json comments,reviews,createdAt`
2. **PR description reactions:** `gh api repos/{owner}/{repo}/issues/<number>/reactions --jq '[.[] | {user: .user.login, content: .content}]'` (derive `{owner}/{repo}` from `gh repo view --json nameWithOwner -q .nameWithOwner`)
3. **Review threads (with resolution status):**
   Derive the owner and repo name from the git remote, then query:
   ```
   gh api graphql -f query='query { repository(owner:"<owner>", name:"<repo>") { pullRequest(number:<number>) { reviewThreads(first:100) { nodes { id isResolved comments(first:5) { nodes { body author { login } path line } } } } } } }'
   ```
4. **CI status:** `gh pr checks <number>`

### 3. Determine review status

Check for feedback from any reviewer — bots (chatgpt-codex-connector[bot], devin-ai-integration[bot]) and humans alike.

**Important:** Only **unresolved** review threads count as "requested changes". Resolved threads represent already-addressed feedback and must be ignored. This ensures re-running `/safe-check-review` after addressing feedback can reach the "all approved" state.

#### chatgpt-codex-connector (appears as `chatgpt-codex-connector[bot]`)

- **Approved:** Left a `+1` reaction on the PR description
- **Requested changes:** Has **unresolved** review threads with comments
- **Pending:** Neither of the above (no reaction and no review threads)

#### devin-ai-integration (appears as `devin-ai-integration[bot]`)

- **Approved:** Left a PR review containing "No Issues Found"
- **Requested changes:** Has **unresolved** review threads with comments
- **Skipped:** No review after 30+ minutes (Devin likely errored out) — treat as approved
- **Pending:** No review from this user (PR < 30 minutes old)

#### Human reviewers

- **Requested changes:** Has **unresolved** review threads
- **Approved:** Left an approving PR review with no unresolved threads
- **Commented:** Left comments but all threads are resolved

#### CI

- **Passing:** All checks passed
- **Failing:** One or more checks failed — read the failing check logs and fix the issues
- **Pending:** Checks are still running

### 4. Display status

Show a summary table:

| Reviewer | Status | Details |
| --- | --- | --- |
| CI | Passing / Failing / Pending | brief summary |
| codex | Approved / Changes requested / Pending | brief summary |
| devin | Approved / Changes requested / Skipped / Pending | brief summary |
| <human> | Commented / Approved / Changes requested | brief summary |

### 5. Address feedback (auto-loop, up to 3 cycles)

Initialize a **cycle counter** at 0, a **fix counter** at 0, and `last_fix_push_time` as `null`.

**Determining aggregate review status:**

Derive an aggregate status from the per-reviewer statuses as follows (higher entries take priority):
- **changes_requested**: Any reviewer (bot or human) has `changes_requested` OR CI is failing.
- **pending**: Any reviewer is `pending` (and none has `changes_requested`).
- **rate_limited**: Any reviewer is `rate_limited` (and none has `changes_requested` or `pending`).
- **approved**: All reviewers have approved (or `skipped` for Devin) and CI is passing.

`changes_requested` always takes priority so that actionable feedback is never masked by a slow/pending reviewer.

#### 5a. Handle pending reviews (initial wait)

If the initial aggregate status from Steps 2–3 is **pending** or **rate_limited**, wait for reviews before acting. Poll every 60 seconds for up to **15 minutes**:

- Re-fetch review data (Step 2 commands) and re-determine aggregate status (Step 3).
- If aggregate status is `approved` → proceed to Step 6.
- If aggregate status is `changes_requested` → enter the feedback loop (5b).
- If aggregate status is `pending` or `rate_limited` → continue polling.
- If 15 minutes pass without resolution → log `"Timed out after 15 minutes waiting for initial reviews on PR #<number>."` and proceed to Step 6.

If the initial aggregate status is **approved** → proceed directly to Step 6.

If the initial aggregate status is **changes_requested** → enter the feedback loop (5b).

#### 5b. Feedback loop

Repeat the following until the exit condition is met:

**Handling stale `changes_requested` from old reviews:**

The `check-pr-reviews` script reports **cumulative** review status — it counts all reviews ever posted, not just unresolved ones. After fixes are pushed and threads are resolved, old reviews still exist in the GitHub API, so `check-pr-reviews` may still return `changes_requested` even though the feedback has been addressed. To avoid infinite loops, use the `last_fix_push_time` timestamp and the `gh api` to check whether any reviews were posted **after** that timestamp before treating `changes_requested` as actionable.

1. **Check cycle limit**: If the cycle counter has reached 3, log: `"Reached maximum feedback cycles (3) for PR #<number>. Stopping."` and proceed to Step 6.

2. **Address the feedback**: Increment both the cycle counter and the fix counter by 1.
   a. Re-fetch review data (Step 2 commands) to get the latest unresolved threads and CI failures.
   b. Create a fix worktree from the PR branch:
      ```bash
      .claude/worktree create safe-plan/<plan-slug>/fix-<fix-counter> origin/<pr-branch>
      ```
   c. Spawn a `general-purpose` agent using the **feedback agent prompt** (see below). The agent pushes fixes directly to the PR branch instead of creating a new PR.
   d. When the agent finishes, clean up the fix worktree:
      ```bash
      .claude/worktree remove safe-plan/<plan-slug>/fix-<fix-counter> --delete-branch
      ```
   e. Fetch the updated PR branch and get the latest commit SHA:
      ```bash
      git fetch origin <pr-branch>
      LATEST_COMMIT=$(git rev-parse origin/<pr-branch>)
      ```
   f. Record the current UTC time as `last_fix_push_time` (e.g., `date -u +%Y-%m-%dT%H:%M:%SZ`).

3. **Re-request reviews**: After fixes are pushed, explicitly tag both reviewers to re-request their review by posting two separate comments on the PR:
   ```bash
   gh pr comment <number> --body "@codex review this PR again — the previous issues have been fixed in commit $LATEST_COMMIT"
   gh pr comment <number> --body "@devin review this PR again — the previous issues have been fixed in commit $LATEST_COMMIT"
   ```
   Log: `"Re-requested reviews from Codex and Devin on PR #<number> (cycle <cycle-counter>/3, commit $LATEST_COMMIT)."`

4. **Wait for fresh reviews**: After fixes are pushed, poll for **new** reviewer activity from Codex and Devin posted after `last_fix_push_time`. Do NOT use `check-pr-reviews` cumulative statuses to determine whether reviewers have responded — old reviews persist in the GitHub API and will make cumulative status checks pass immediately on subsequent cycles.
   - Poll every 60 seconds for up to **10 minutes**.
   - On each poll, collect the **login names** of reviewer bots that have posted new activity (reviews, inline comments, issue comments, or reactions) after `last_fix_push_time`:
     ```bash
     # Get reviewer bot logins with new reviews after last_fix_push_time
     review_bot_logins=$(gh api "repos/{owner}/{repo}/pulls/<number>/reviews" \
       --jq '[.[] | select(.submitted_at > "'$last_fix_push_time'" and (.user.login == "chatgpt-codex-connector[bot]" or .user.login == "devin-ai-integration[bot]"))] | [.[].user.login] | unique | .[]')
     # Get reviewer bot logins with new inline comments after last_fix_push_time
     comment_bot_logins=$(gh api "repos/{owner}/{repo}/pulls/<number>/comments" \
       --jq '[.[] | select(.created_at > "'$last_fix_push_time'" and (.user.login == "chatgpt-codex-connector[bot]" or .user.login == "devin-ai-integration[bot]"))] | [.[].user.login] | unique | .[]')
     # Get reviewer bot logins with new issue comments after last_fix_push_time
     issue_comment_bot_logins=$(gh api "repos/{owner}/{repo}/issues/<number>/comments" \
       --jq '[.[] | select(.created_at > "'$last_fix_push_time'" and (.user.login == "chatgpt-codex-connector[bot]" or .user.login == "devin-ai-integration[bot]"))] | [.[].user.login] | unique | .[]')
     # Get reviewer bot logins with new reactions after last_fix_push_time (e.g., Codex +1 approval)
     reaction_bot_logins=$(gh api "repos/{owner}/{repo}/issues/<number>/reactions" \
       --jq '[.[] | select(.created_at > "'$last_fix_push_time'" and (.user.login == "chatgpt-codex-connector[bot]" or .user.login == "devin-ai-integration[bot]"))] | [.[].user.login] | unique | .[]')
     # Union all logins across endpoints into a set of responding bots and count
     responded_bot_logins=$(printf "%s\n%s\n%s\n%s\n" "$review_bot_logins" "$comment_bot_logins" "$issue_comment_bot_logins" "$reaction_bot_logins" | sort -u | grep .)
     all_responded_bots=$(echo "$responded_bot_logins" | grep -c .)
     ```
     A reviewer bot counts as "responded" if its login appears in any of the four queries above. Collect all unique responding logins into `responded_bot_logins`, and also compute `all_responded_bots` (the count).
   - If `all_responded_bots` is **>= 1** (at least one reviewer bot has posted new activity after `last_fix_push_time`), run `.claude/check-pr-reviews <number>` and derive the aggregate status. **Important:** when the aggregate status would be `changes_requested`, verify that the bot with `changes_requested` is in `responded_bot_logins` — if it is not (meaning the `changes_requested` comes from a bot that has not yet responded to the new commit), treat the status as `pending` instead and continue polling.
     - If aggregate status is `approved` → proceed to Step 6.
     - If aggregate status is `changes_requested` **and the bot with `changes_requested` is in `responded_bot_logins`** → return to step 1 of this loop (cycle limit check).
     - Otherwise (`pending`, `rate_limited`, or `changes_requested` from a non-responding bot) → continue polling.
   - If `all_responded_bots` is **< 1**, **continue polling** — do not exit the loop. Old cumulative statuses from `check-pr-reviews` are unreliable after fixes have been pushed.
   - If **10 minutes** pass without any reviewer bot posting new activity → log `"Timed out after 10 minutes waiting for reviewer responses on PR #<number>."` and proceed to Step 6.

Repeat steps 1–4 until the exit condition: either `approved` aggregate status, actionable `changes_requested` from a freshly-responding bot, 10-minute timeout after a fix push, or the cycle counter has reached 3.

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
<absolute path to fix worktree>
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

### 6. Update state

Update `.private/safe-plan-state/<plan-slug>.md` to record the review cycles completed:

```markdown
- **Review cycles completed**: <cycle-counter>/3
```

### 7. Notify the user and stop

If all reviewers have approved, tell the user:

> All reviews are in — no actionable feedback. Run `/resume-plan <plan file>` to merge and continue.
>
> - **Review cycles completed:** <cycle-counter>/3

If the cycle limit was reached:

> Reached maximum feedback cycles (3/3). PR #<number> still has pending feedback.
>
> - **Review cycles completed:** 3/3
> - **Final review status:** Max cycles reached — manual review required
>
> **Next steps:**
> - Review the remaining feedback on GitHub: <PR link>
> - Address manually and push to `<branch>`, then re-run `/safe-check-review <plan file>`

If timed out waiting for reviews:

> Timed out waiting for reviewer responses. PR #<number> is ready but reviews may still be pending.
>
> - **Review cycles completed:** <cycle-counter>/3
> - **Final review status:** Timed out waiting for reviews
>
> **Next steps:**
> - Check for pending reviews on GitHub: <PR link>
> - Re-run `/safe-check-review <plan file>` once reviews are in, or run `/resume-plan <plan file>` to merge now

Do NOT suggest running `/resume-plan` if any reviewer has unresolved `changes_requested`.

## Repo-specific gotchas

Follow the project conventions described in AGENTS.md.
