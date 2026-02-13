Implement the requested changes in an isolated worktree and open a PR for human review. Unlike `/do`, this command does NOT auto-merge — it pauses so you can review the PR before merging.

The user passed: `$ARGUMENTS`

If `$ARGUMENTS` is empty, stop and tell the user to provide a description of what to do. Example: `/safe-do Add input validation to the login form`.

## Repo-specific gotchas

- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- **Bun PATH**: Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
- **Imports**: All imports use `.js` extensions (NodeNext module resolution).
- **Project structure**: Bun + TypeScript project. Code is in `assistant/`.

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

Working entirely inside the worktree directory, implement what was requested. Explore the codebase, make changes, add tests if appropriate, and type-check:

```bash
cd <worktree>/assistant && export PATH="$HOME/.bun/bin:$PATH" && bunx tsc --noEmit
```

### 3. Stage and commit

```bash
cd <worktree>
git add -A
git diff --cached
```

Review the staged diff. Draft a clear commit message. Commit:

```bash
git commit -m "$(cat <<'EOF'
<commit message>

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### 4. Push and create PR (do NOT merge)

```bash
git push -u origin HEAD
```

Infer a concise PR title from the changes.

```bash
gh pr create --base main --title "<title>" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### 5. Add to unreviewed list

Read `.private/UNREVIEWED_PRS.md`, append the new PR link, write it back.

### 6. Notify the user and stop

Tell the user:

> **PR is ready for review:** <PR link>
>
> - <brief summary of what was implemented>
> - Files changed: <list>
> - Worktree: `<worktree path>` (kept for addressing feedback)
>
> **Next steps:**
> - Review the PR on GitHub
> - To merge: `gh pr merge <N> --squash`
> - To clean up the worktree after merging: `.claude/worktree remove safe-do/<slug> --delete-branch`
> - To pull main after merging: `git checkout main && git pull origin main`

Then **stop**. Do NOT merge the PR.

## Important

- .private/UNREVIEWED_PRS.md is written to by other processes. Read before writing, verify after writing.
- The worktree is intentionally left in place so feedback can be addressed without recreating it.
