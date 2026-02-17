Implement the requested changes in an isolated worktree, then ship them to main via a squash-merged PR.

The user passed: `$ARGUMENTS`

If `$ARGUMENTS` is empty, stop and tell the user to provide a description of what to do. Example: `/do Add input validation to the login form`.

## Repo-specific gotchas

- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- **Bun PATH**: Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
- **Imports**: All imports use `.js` extensions (NodeNext module resolution).
- **Project structure**: Bun + TypeScript project. Code is in `assistant/`.

## Steps

### 1. Create worktree

Derive a short branch name slug from the description (e.g. `do/add-login-validation`).

Fetch the latest main and create the worktree based on `origin/main` so the branch doesn't include unrelated commits:

```bash
git fetch origin main
.claude/worktree create do/<slug> origin/main
```

Remember the worktree path printed by the script. ALL work happens in the worktree — do NOT modify files in the main repo.

### 2. Implement the changes

Working entirely inside the worktree directory, implement what was requested. Explore the codebase, make changes, add tests if appropriate, and type-check:

```bash
cd <worktree>/assistant && export PATH="$HOME/.bun/bin:$PATH" && bunx tsc --noEmit
```

### 3. Ship

Review what changed, draft a commit message and PR title, then ship everything in one step.

**Run from the worktree root** (not `assistant/` or the main repo):

```bash
cd <worktree> && .claude/ship \
  --commit-msg "<commit message>" \
  --title "<PR title>" \
  --body "## Summary
<1-3 bullet points>

🤖 Generated with [Claude Code](https://claude.com/claude-code)" \
  --base main \
  --merge \
  --track-unreviewed \
  --cleanup-worktree do/<slug> \
  --pull-base
```

### 4. Report

Output the PR link (printed by `.claude/ship`) and a summary of what was shipped. End your message with "Done."
