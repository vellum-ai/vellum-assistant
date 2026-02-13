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

### 2. Fetch review data

Using the PR number from the state file, run these commands in parallel:

1. **Reviews and comments:** `gh pr view <number> --json comments,reviews,createdAt`
2. **PR description reactions:** `gh api repos/vellum-ai/vellum-assistant/issues/<number>/reactions --jq '[.[] | {user: .user.login, content: .content}]'`
3. **Review threads (with resolution status):**
   ```
   gh api graphql -f query='query { repository(owner:"vellum-ai", name:"vellum-assistant") { pullRequest(number:<number>) { reviewThreads(first:100) { nodes { id isResolved comments(first:5) { nodes { body author { login } path line } } } } } } }'
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
- **Pending:** No review from this user

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
| devin | Approved / Changes requested / Pending | brief summary |
| <human> | Commented / Approved / Changes requested | brief summary |

### 5. Address feedback (if any)

If any reviewer requested changes OR CI is failing:

1. Read the worktree path and branch from the state file.
2. Pull latest changes in the worktree:
   ```bash
   cd <worktree> && git pull origin <branch>
   ```
3. If CI is failing, read the failing check logs to understand what went wrong. If reviewers requested changes, read the **unresolved** review threads from step 2. Implement all fixes in the worktree.
4. Validate:
   ```bash
   cd <worktree>/assistant && export PATH="$HOME/.bun/bin:$PATH" && bunx tsc --noEmit
   ```
5. Commit and push:
   ```bash
   cd <worktree>
   git add -A
   git commit -m "$(cat <<'EOF'
Address review feedback

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
   )"
   git push origin HEAD
   ```
6. For each unresolved thread from step 2, reply and resolve:
   ```
   gh api graphql -f query='mutation { addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:"<thread-id>", body:"Addressed in latest push."}) { comment { id } } }'
   gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:"<thread-id>"}) { thread { isResolved } } }'
   ```
7. After pushing, request re-review by posting two separate comments on the PR:
   ```bash
   gh pr comment <number> --body "@codex review"
   gh pr comment <number> --body "@devin review"
   ```
8. Tell the user what feedback was addressed and what changes were made.

If any reviewer is still **Pending** (no response yet), tell the user:

> Still waiting on reviews from: <list of pending reviewers>. Check back in a few minutes with `/safe-check-review <plan file>`.

Do NOT suggest running `/resume-plan` while reviews are pending.

If all reviewers have responded, none requested changes (all approved), and CI is passing, tell the user:

> All reviews are in — no actionable feedback. Run `/resume-plan <plan file>` to merge and continue.

## Repo-specific gotchas

- **Bun PATH**: Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
- **Imports**: All imports use `.js` extensions (NodeNext module resolution).
- **Project structure**: Bun + TypeScript project. Code is in `assistant/`.
