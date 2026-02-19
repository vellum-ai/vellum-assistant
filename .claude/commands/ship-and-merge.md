Create a PR from the current uncommitted changes, wait for Codex and Devin reviews, fix any valid feedback, and merge once approved.

If the user passed `$ARGUMENTS`, use it as the PR title. Otherwise, infer a concise title from the changes.

## Repo-specific gotchas

- **gh pr view fields**: `merged` is NOT a valid --json field. Use `state` and `mergedAt`: `gh pr view <N> --json state,mergedAt,title,url`
- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- **CI**: Do NOT wait for CI checks to pass before merging. Merge immediately.
- **No piping to tail/head**: `tail` and `head` may not be available in the shell. Don't pipe to them.

## Phase 1: Create the PR

### 1. Check for changes

```bash
git status
git diff
```

If there are no staged or unstaged changes, stop and tell the user there's nothing to ship.

### 2. Create a fresh branch

Always create a fresh branch from main so the PR only contains the uncommitted changes — never reuse an existing non-main branch, which could include unrelated commits.

```bash
git stash --include-untracked
git checkout main && git pull
git checkout -B <user>/<slug-from-title>
git stash pop
```

### 3. Stage, commit, push, and create the PR

Review the changes and draft a commit message and PR title (use `$ARGUMENTS` as the title if provided).

```bash
git add -A
git commit -m "<commit message>

Co-Authored-By: Claude <noreply@anthropic.com>"
git push -u origin HEAD
gh pr create --base main --title "<PR title>" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

## Original prompt
$ARGUMENTS

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" --assignee @me
```

Note the PR number and URL.

## Phase 2: Wait for reviews

Poll for reviews every 60 seconds using `.claude/check-pr-reviews <number>`. Stop polling once both `codex.status` and `devin.status` are no longer `pending`.

```bash
.claude/check-pr-reviews <number>
```

- If Codex is `rate_limited`, re-trigger by commenting `@codex review` on the PR, then continue polling.
- Keep polling until both reviewers have responded (status is `approved`, `changes_requested`, or for Codex `rate_limited` that was re-triggered).
- Maximum wait: 10 minutes. If neither reviewer responds after 10 minutes, tell the user reviews are still pending and stop.

## Phase 3: Assess feedback

If both reviewers approved, skip to Phase 5 (merge).

If either reviewer requested changes, assess each piece of feedback:

### 1. Read the PR diff

```bash
gh pr diff <number>
```

### 2. Evaluate each comment

For each piece of feedback, classify it:

- **Valid feedback**: The suggestion improves the code without regressing intended behavior. Fix it.
- **Nonsensical feedback**: The reviewer misunderstood the code or the suggestion doesn't apply. Ignore it.
- **Regression risk**: Addressing the feedback would undo or break desired functionality. Flag to the user and stop — ask whether to fix it, ignore it, or do something else. Do NOT continue until the user responds.

## Phase 4: Fix valid feedback

If there is valid feedback to address:

1. Read the inline comments to understand the requested changes:

```bash
gh api repos/{owner}/{repo}/pulls/<number>/comments --jq '.[] | {path: .path, line: .line, body: .body}'
```

2. Implement the fixes on the same branch.

3. Stage, commit, and push:

```bash
git add -A
git commit -m "address review feedback

Co-Authored-By: Claude <noreply@anthropic.com>"
git push
```

4. Go back to Phase 2 — wait for the reviewers to re-review.

**Loop limit:** Maximum 3 feedback rounds. If reviewers are still requesting changes after 3 rounds, stop and tell the user.

## Phase 5: Merge

Once both reviewers have approved (or their feedback was classified as nonsensical):

```bash
gh pr merge <number> --squash
```

Verify the merge:

```bash
gh pr view <number> --json state,mergedAt
```

Track the merged PR for review triage:

```bash
mkdir -p .private
echo "<pr-url>" >> .private/UNREVIEWED_PRS.md
```

## Phase 6: Clean up

```bash
git checkout main
git pull origin main
git branch -d <branch-name>
```

If `-d` fails, use `-D` since the PR was already squash-merged.

## Phase 7: Report

Print a summary:

```
## Shipped

**PR:** #<number> — <title> (<url>)
**Reviews:** <number of feedback rounds, or "approved on first pass">
**Branch:** `<branch-name>` — deleted

You're on `main` with the latest changes.
```
