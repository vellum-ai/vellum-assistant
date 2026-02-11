You are running a single iteration of a cronjob that runs periodically for task scheduling.

<instructions>

Look at every item in .private/UNREVIEWED_PRS.md. Each line is a PR URL like `https://github.com/vellum-ai/vellum-assistant/pull/123`.

Check each PR to see if **both** chatgpt-codex-connector and devin-ai-integration have reviewed it and whether they have feedback.

## How to fetch PR data

For each PR, run these commands in parallel:

1. **Reviews, comments, and creation time:** `gh pr view <number> --json comments,reviews,createdAt`
2. **PR description reactions:** `gh api repos/vellum-ai/vellum-assistant/issues/<number>/reactions --jq '[.[] | {user: .user.login, content: .content}]'`

Note: PR description reactions use the **issues** API endpoint (not pulls). The `reactionGroups` field from `gh pr view` doesn't include user info.

Also fetch inline review comments if needed: `gh api repos/vellum-ai/vellum-assistant/pulls/<number>/comments --jq '[.[] | {user: .user.login, body: .body}]'`

## How to determine review status

### chatgpt-codex-connector (appears as `chatgpt-codex-connector[bot]`)

- **Approved:** Left a `+1` reaction on the PR description (check the issues reactions endpoint)
- **Requested changes:** Left a PR review or inline review comment with suggestions/issues (look for reviews or comments by `chatgpt-codex-connector[bot]`)
- **Pending:** Neither of the above

### devin-ai-integration (appears as `devin-ai-integration[bot]`)

- **Approved:** Left a PR review containing "No Issues Found" (typically "✅ Devin Review: No Issues Found")
- **Requested changes:** Left a PR review or inline comment with issues/findings (any review that does NOT say "No Issues Found")
- **Pending:** No review from this user

## Skipping slow reviewers (30-minute timeout)

If a PR was created **30 or more minutes ago** (based on `createdAt`) and only **one** of Codex or Devin has reviewed it while the other is still pending, treat the pending reviewer as **skipped**. A skipped review counts as an implicit approval. If **neither** has reviewed after 30 minutes, do NOT skip — keep waiting (both still pending).

When a reviewer is skipped:
- The PR is considered "fully reviewed" (just like if both had responded).
- The skipped reviewer's status should display as "Skipped" in the output table.
- Apply the normal actions logic using the one real review plus the implicit approval from the skip.

## Actions

- If either reviewer hasn't reviewed yet **and** the PR is less than 30 minutes old, keep the PR in UNREVIEWED_PRS.md for next time.
- If the PR is 30+ minutes old and at least one reviewer has responded, treat any missing reviewer as skipped (implicit approval) and proceed as fully reviewed.
- If both have reviewed (or one reviewed + one skipped) and either **real** review requested changes, add `- Address the feedback on <link to PR>` to the **top** of .private/TODO.md (ordered by PR number, lowest first).
- If fully reviewed (both reviewed, or one reviewed + one skipped), remove the PR from .private/UNREVIEWED_PRS.md.

## Output

Display a table with these columns:

| PR  | Age | Codex | Devin | Fully Reviewed | Added to TODO | Removed from Unreviewed |
| --- | --- | ----- | ----- | -------------- | ------------- | ----------------------- |

- **Age**: How long ago the PR was created (e.g., "2h 15m", "45m"). Include a ⏰ marker if the 30-minute timeout triggered a skip.
- **Codex/Devin columns**: Show "Approved", "Changes requested", "Pending", or "Skipped" (when the 30-min timeout applied).

</instructions>

IMPORTANT: .private/TODO.md and .private/UNREVIEWED_PRS.md are written to by other processes so make sure you read them before writing to them and after writing to them. Don't be alarmed if you see changes that you didn't make, but make sure your changes are persisted and you're not overwriting other changes. .private/TODO.md and .private/UNREVIEWED_PRS.md are gitignored.
