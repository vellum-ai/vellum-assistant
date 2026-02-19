You are running a single iteration of a cronjob that runs periodically for task scheduling.

<instructions>

Look at every item in .private/UNREVIEWED_PRS.md. Each line is a PR URL like `https://github.com/<owner>/<repo>/pull/123`.

Check each PR to see if **both** chatgpt-codex-connector and devin-ai-integration have reviewed it and whether they have feedback.

## How to fetch PR data and determine review status

Extract all PR numbers from UNREVIEWED_PRS.md and check them in a single call:

```bash
.claude/check-pr-reviews <number1> <number2> <number3> ...
```

With multiple PR numbers, this outputs a JSON array of results. Each element has `title`, `codex.status` and `devin.status` fields (each one of: `approved`, `changes_requested`, `rate_limited`, `skipped`, `pending`), plus the raw review data (`reviews`, `inline_comments`) for contextual assessment. It also includes `age_seconds` for computing the age column. All PRs are fetched in parallel for speed.

## Contextual review assessment

When a reviewer requests changes, don't blindly add the feedback to TODO. First assess whether the feedback actually makes sense:

### 1. Understand the PR's intent

Read the PR diff to understand what the PR is trying to accomplish:
`gh pr diff <number>`

### 2. Trace the feedback chain

Check if this PR is itself addressing feedback from an earlier PR. Look at:
- **Branch name:** branches named `fix/pr-<N>-*` are feedback PRs for PR #N
- **PR title/body:** may reference the original PR directly

If the PR is a feedback-addressing PR, fetch the original PR it references and read its diff too. Keep following the chain (the original may itself be a feedback PR) until you reach the **base PR** — the one that introduced the feature or fix. Read each PR's diff along the way so you understand the full context.

### 3. Evaluate the feedback

For each piece of reviewer feedback, assess:
- Does this feedback make sense given what the PR (and the chain of PRs leading to it) is trying to do?
- Would addressing this feedback **undo or regress** the functionality that the base PR introduced?

Examples of feedback that would cause a regression:
- Suggesting removal of code that was the whole point of the base PR
- Recommending a pattern that contradicts a deliberate design choice from the original implementation
- Flagging as "unused" something that was intentionally added and is used elsewhere

### 4. Classify the feedback

- **Valid feedback:** The suggestion improves the code without regressing the intended behavior. → Add to TODO as normal.
- **Regression risk:** Addressing the feedback would undo or break the desired functionality from the base PR. → Flag to user (see below).
- **Nonsensical feedback:** The reviewer misunderstood the code or the suggestion doesn't apply. → Discard silently and treat as an implicit approval for that reviewer.

## Actions

- **Rate-limited Codex:** If Codex is rate-limited, re-trigger the review by commenting `@codex review` on the PR and keep the PR in UNREVIEWED_PRS.md. Do NOT remove the PR.
- **Skipped Devin:** If Devin's status is `skipped` (pending for 30+ minutes), treat it as if Devin approved — Devin likely errored out and won't review.
- If either reviewer hasn't reviewed yet (status is `pending`, not `skipped`), keep the PR in UNREVIEWED_PRS.md for next time.
- If both have reviewed and either review requested changes with **valid feedback**, add `- Address the feedback on <link to PR>` to the **top** of .private/TODO.md (ordered by PR number, lowest first).
- If all feedback on a PR was classified as nonsensical, treat that reviewer as having approved.
- If any feedback is classified as **regression risk**, do NOT add it to TODO. Instead, flag it to the user (see output section) and **stop processing further PRs**. Keep the PR in .private/UNREVIEWED_PRS.md so it is revisited on the next run. Wait for the user to decide what to do.
- If fully reviewed (both have reviewed), Codex is not rate-limited, and no feedback was classified as regression risk, remove the PR from .private/UNREVIEWED_PRS.md.

## Output

Display a table with these columns:

| PR  | Title | Age | Codex | Devin | Verdict | TODO | Removed |
| --- | ----- | --- | ----- | ----- | ------- | ---- | ------- |

- **PR**: Just the PR number (e.g., `#5471`), not the full URL.
- **Title**: PR title, truncated to 30 characters with "..." if longer.
- **Age**: How long ago the PR was created (e.g., "2h 15m", "45m").
- **Codex/Devin columns**: Use emoji prefixes for quick scanning:
  - ✅ Approved
  - ❌ Changes requested
  - ⏳ Pending
  - 🔇 Skipped (Devin only — timed out after 30 minutes)
  - 🤷 Nonsensical (feedback didn't apply)
  - 🔄 Rate-limited (Codex only — re-triggered via `@codex review` comment)
- **Verdict**: Use emoji prefixes:
  - ✅ Approved
  - 📝 Valid feedback
  - ⚠️ Regression risk
  - ⏳ Pending
- **TODO / Removed**: Use ✅ for yes, — for no.

### Regression risk flagging

When feedback is classified as regression risk, stop and present the following to the user:

1. **The feedback chain**: List each PR in the chain from base PR → current PR, with one-line summaries of what each did.
2. **The problematic feedback**: Quote the specific reviewer comment(s).
3. **Why it's a regression risk**: Explain what functionality would be lost or broken if the feedback were addressed.
4. **Ask the user**: "Should I add this to TODO anyway, discard the feedback, or do something else?"

Do NOT continue processing remaining PRs until the user responds.

</instructions>

## Phase 2: Check for merged PRs with CI failures

After processing all items in UNREVIEWED_PRS.md, check for recently merged PRs where CI failed on the main branch.

### How to detect CI failures

Run: `gh run list --branch main --status failure --limit 10 --json databaseId,headSha,displayTitle,url,conclusion,createdAt,event`

This returns failed workflow runs on main. For each failed run:

1. **Find the associated PR**: Use `gh pr list --state merged --search "<headSha>" --json number,url,title,mergedAt --limit 1` or cross-reference the run's `displayTitle` / `headSha` with merged PRs. If you can't find a matching PR, use the run URL directly.
2. **Skip if already in TODO**: Read .private/TODO.md and check if there's already a `Fix CI failures` entry for that PR or run. Don't add duplicates.
3. **Add to TODO**: For each new CI failure, add `- Fix CI failures from merged PR <link to PR> (run: <link to failed run>)` to the **top** of .private/TODO.md (after any "Address the feedback" items, but before other tasks).

### Output

Append a second table to the output:

**CI Failures on main:**

| Run | PR | Title | Age | Added to TODO |
| --- | --- | ----- | --- | ------------- |

- **Run**: Link to the failed GitHub Actions run
- **PR**: Link to the PR that introduced the failure (if identifiable), or "—"
- **Title**: The run's display title
- **Age**: How long ago the run was created
- **Added to TODO**: ✅ if added, `dup` if already in TODO, — if skipped for other reasons

If there are no CI failures on main, print: "No CI failures on main. ✅"

IMPORTANT: .private/TODO.md and .private/UNREVIEWED_PRS.md are written to by other processes so make sure you read them before writing to them and after writing to them. Don't be alarmed if you see changes that you didn't make, but make sure your changes are persisted and you're not overwriting other changes. .private/TODO.md and .private/UNREVIEWED_PRS.md are gitignored.
