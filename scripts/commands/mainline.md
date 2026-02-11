Ship the current uncommitted changes to main via a squash-merged PR.

If the user passed `$ARGUMENTS`, use it as the PR title. Otherwise, infer a concise title from the changes.

## Steps

### 1. Check for changes

```bash
git status
git diff
```

If there are no staged or unstaged changes, stop and tell the user there's nothing to mainline.

### 2. Create a branch (if needed)

If already on a non-main branch, skip this step and use the current branch.

Otherwise, create a new branch from the changes:

```bash
git checkout -b <user>/<slug-from-title>
```

### 3. Stage and commit

```bash
git add -A
git diff --cached
```

Review the staged diff. Draft a clear commit message summarizing the changes. Commit:

```bash
git commit -m "$(cat <<'EOF'
<commit message>

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### 4. Push

```bash
git push -u origin HEAD
```

### 5. Create the PR

```bash
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### 6. Add to unreviewed list

Read `.private/UNREVIEWED_PRS.md`, append the new PR link, write it back.

### 7. Merge

```bash
gh pr merge <N> --squash
```

### 8. Switch back to main and pull

```bash
git checkout main && git pull
```

### 9. Report

Output the PR link and a summary of what was shipped. End your message with "Mainlined."

## Repo-specific gotchas

- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- **Bun PATH**: Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.

IMPORTANT: .private/UNREVIEWED_PRS.md is written to by other processes. Read before writing, verify after writing.
