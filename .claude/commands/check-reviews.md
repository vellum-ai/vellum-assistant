You are running a single iteration of a cronjob that runs periodically for task scheduling.

Arguments (optional): $ARGUMENTS

Parse optional flags from `$ARGUMENTS`:

- **`--namespace NAME`** (optional): when provided, only process PRs whose head branch starts with `swarm/<NAME>/`. Any TODO items added will be prefixed with `[<NAME>]` (e.g., `- [<NAME>] Address the feedback on <link>`). When omitted, process all PRs. TODO items will still be namespaced if the PR's branch name matches `swarm/<NAME>/...` (the namespace is inferred from the branch).
- **`--force`** (optional): skip active blitz filtering (see below). Process all PRs regardless of whether they're owned by a running blitz.

To check a PR's head branch name, include `headRefName` in the `--json` fields when fetching PR data.

<instructions>

## Active blitz detection

Before processing PRs, check if any blitz or safe-blitz runs are actively managing their own review cycles. This prevents standalone check-reviews from picking up work that's already being handled by an in-process blitz.

**Skip this section entirely if `--namespace` was explicitly provided or `--force` was passed.** When `--namespace` is provided, the caller is explicitly claiming ownership of that namespace (this is how the blitz sweep itself calls check-reviews). When `--force` is passed, the caller wants to process everything regardless.

If neither `--namespace` nor `--force` was provided:

1. Check if `.private/ACTIVE_BLITZ.md` exists. If not, skip to the main processing below.
2. Read `.private/ACTIVE_BLITZ.md`. Each non-empty, non-comment line (lines not starting with `#`) represents an active blitz run in the format:
   ```
   <namespace> <type> <heartbeat-ISO-timestamp>
   ```
   Example: `approval-conv-flow safe-blitz 2026-02-26T10:00:00Z`

3. For each entry, check if the heartbeat is stale (older than 30 minutes):
   ```bash
   HEARTBEAT="<heartbeat-timestamp>"
   HEARTBEAT_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$HEARTBEAT" "+%s" 2>/dev/null)
   NOW_EPOCH=$(date "+%s")
   AGE=$(( NOW_EPOCH - HEARTBEAT_EPOCH ))
   ```
   - If `AGE > 1800` (30 minutes): the entry is stale. Remove it from the file and log: `"Removing stale blitz entry '<namespace>' (last heartbeat <AGE>s ago)"`. Do not add this namespace to the exclusion list.
   - If `AGE <= 1800`: add the namespace to an internal **exclusion list**.

4. When building the list of PRs to process from UNREVIEWED_PRS.md, exclude any PR whose head branch starts with `swarm/<excluded-namespace>/` for any namespace in the exclusion list. Log: `"Skipping <N> PRs owned by active <type> '<namespace>' (heartbeat <AGE>s ago)"`

5. Include the skipped PRs in the output table with a new verdict: `🔒 Owned` and a note indicating which blitz owns them. Do NOT remove these PRs from UNREVIEWED_PRS.md.

---

Look at every item in .private/UNREVIEWED_PRS.md. Each line is a PR URL like `https://github.com/<owner>/<repo>/pull/123`.

**If `--namespace` was provided**: before processing, filter the PR list to only include PRs whose head branch starts with `swarm/<namespace>/`. Skip all other PRs (leave them in UNREVIEWED_PRS.md untouched).

Check each PR to see if **both** chatgpt-codex-connector and devin-ai-integration have reviewed it and whether they have feedback.

## How to fetch PR data and determine review status

Extract all PR numbers from UNREVIEWED_PRS.md and check them in a single call:

```bash
.claude/check-pr-reviews <number1> <number2> <number3> ...
```

With multiple PR numbers, this outputs a JSON array of results. Each element has `title`, `head_ref_name`, `codex.status` and `devin.status` fields (each one of: `approved`, `changes_requested`, `rate_limited`, `skipped`, `pending`), plus the raw review data (`reviews`, `inline_comments`) for contextual assessment. It also includes `age_seconds` for computing the age column. All PRs are fetched in parallel for speed.

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
- If both have reviewed and either review requested changes with **valid feedback**, add the feedback item to the **top** of .private/TODO.md (ordered by PR number, lowest first). Determine the namespace prefix for the TODO item using this priority:
  1. If `--namespace` was explicitly provided, use it: `- [<namespace>] Address the feedback on <link to PR>`.
  2. Otherwise, if the PR's `head_ref_name` matches `swarm/<NAME>/...`, extract `<NAME>` and use it: `- [<NAME>] Address the feedback on <link to PR>`.
  3. Otherwise, no prefix: `- Address the feedback on <link to PR>`.
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
  - 🔒 Owned (PR belongs to an active blitz — skipped)
- **TODO / Removed**: Use ✅ for yes, — for no.

### Regression risk flagging

When feedback is classified as regression risk, stop and present the following to the user:

1. **The feedback chain**: List each PR in the chain from base PR → current PR, with one-line summaries of what each did.
2. **The problematic feedback**: Quote the specific reviewer comment(s).
3. **Why it's a regression risk**: Explain what functionality would be lost or broken if the feedback were addressed.
4. **Ask the user**: "Should I add this to TODO anyway, discard the feedback, or do something else?"

Do NOT continue processing remaining PRs until the user responds.

</instructions>

IMPORTANT: .private/TODO.md and .private/UNREVIEWED_PRS.md are written to by other processes so make sure you read them before writing to them and after writing to them. Don't be alarmed if you see changes that you didn't make, but make sure your changes are persisted and you're not overwriting other changes. .private/TODO.md and .private/UNREVIEWED_PRS.md are gitignored.
