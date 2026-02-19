Ship the current uncommitted changes to main via a squash-merged PR.

If the user passed `$ARGUMENTS`, use it as the PR title. Otherwise, infer a concise title from the changes.

## Repo-specific gotchas

- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- **CI**: Do NOT wait for CI checks to pass before merging. Merge immediately.

## Steps

### 1. Check for changes

```bash
git status
git diff
```

If there are no staged or unstaged changes, stop and tell the user there's nothing to mainline.

### 2. Create a fresh branch

Always create a fresh branch from main so the PR only contains the uncommitted changes — never reuse an existing non-main branch, which could include unrelated commits.

```bash
git stash --include-untracked
git checkout main && git pull
git checkout -B <user>/<slug-from-title>
git stash pop
```

### 3. Ship

Review the changes, draft a commit message and PR title (use `$ARGUMENTS` as the title if provided), then ship:

```bash
PR_BODY=$(cat <<'BODY_EOF'
## Summary
<1-3 bullet points>

## Context
<if $ARGUMENTS was provided, paste it here; otherwise briefly describe what prompted these changes>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY_EOF
)
.claude/ship \
  --commit-msg "<commit message>" \
  --title "<PR title>" \
  --body "$PR_BODY" \
  --base main \
  --merge \
  --track-unreviewed \
  --pull-base
```

### 4. Report

Output the PR link (printed by `.claude/ship`) and a summary of what was shipped. End your message with "Mainlined."
