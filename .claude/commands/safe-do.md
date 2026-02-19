Implement the requested changes in an isolated worktree and open a PR for human review. Unlike `/do`, this command does NOT auto-merge — it pauses so you can review the PR before merging.

The user passed: `$ARGUMENTS`

If `$ARGUMENTS` is empty, stop and tell the user to provide a description of what to do. Example: `/safe-do Add input validation to the login form`.

## Repo-specific gotchas

- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- **CI**: Do NOT wait for CI checks to pass before merging. Merge immediately.

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

Working entirely inside the worktree directory, implement what was requested. Explore the codebase and make changes.

**Do NOT run tests, type-checking (`tsc`), or linting unless the task specifically requires it** (e.g., "fix the type errors", "make the tests pass"). These steps are slow and rarely catch issues for well-scoped changes.

### 3. Ship (do NOT merge)

Review what changed, draft a commit message and PR title, then ship.

**Run from the worktree root** (not `assistant/` or the main repo):

```bash
cd <worktree> && .claude/ship \
  --commit-msg "<commit message>" \
  --title "<PR title>" \
  --body "## Summary
<1-3 bullet points>

🤖 Generated with [Claude Code](https://claude.com/claude-code)" \
  --base main \
  --track-unreviewed
```

### 4. Notify the user and stop

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
