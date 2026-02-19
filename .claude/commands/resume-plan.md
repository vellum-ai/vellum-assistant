Merge the current plan PR and continue to the next one.

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

### 2. Merge the current PR

```bash
gh pr merge <number> --squash
```

### 3. Clean up worktree

Change back to the main repo directory, then remove the worktree:

```bash
cd <main-repo>
.claude/worktree remove safe-plan/<plan-slug>/<pr-slug> --delete-branch
```

### 4. Remove from unreviewed list

Read `.private/UNREVIEWED_PRS.md`, remove the merged PR link, write it back.

### 5. Pull main

```bash
git checkout main && git pull origin main
```

### 6. Report what was merged

Tell the user:
> **Merged PR <X> of <total>:** <PR link>

### 7. Check if plan is complete

Read the plan file from `.private/plans/<plan filename>`. If all PRs are done:

1. Archive the plan:
   ```bash
   PLAN_FILE="$(basename -- "<plan filename>")"
   mkdir -p .private/plans/archived
   mv ".private/plans/$PLAN_FILE" ".private/plans/archived/$PLAN_FILE"
   ```
2. Delete `.private/safe-plan-state/<plan-slug>.md`.
3. Tell the user:
   > **Plan complete!** All <total> PRs have been merged.
4. Stop.

### 8. Implement the next PR

If there are remaining PRs, follow the same implementation workflow as `/safe-execute-plan`:

#### 8a. Create worktree

```bash
git fetch origin main
.claude/worktree create safe-plan/<plan-slug>/<pr-slug> origin/main
```

#### 8b. Implement

Read the next PR section from the plan. Implement all changes in the worktree.
- Follow the project conventions.
- Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.

#### 8c. Validate

**Do NOT run tests, type-checking (`tsc`), or linting unless the plan's PR section explicitly specifies validation steps.** These steps are slow and rarely catch issues for well-scoped changes.

#### 8d. Ship (do NOT merge)

**Run from the worktree root** (not `assistant/` or the main repo):

```bash
cd <worktree> && .claude/ship \
  --commit-msg "<commit message>" \
  --title "<title from plan>" \
  --body "## Summary
<1-3 bullet points>

## Plan section
<paste the full text of this PR's section from the plan file, verbatim>

Part of plan: <plan filename> (PR <X> of <total>)

🤖 Generated with [Claude Code](https://claude.com/claude-code)" \
  --base main \
  --track-unreviewed
```

### 9. Save state

Update `.private/safe-plan-state/<plan-slug>.md` with the new PR info:

```markdown
# Safe Plan State

- **Plan**: <plan filename>
- **Current PR**: <X> of <total>
- **PR URL**: <github PR URL>
- **PR Number**: <number>
- **Branch**: <branch name>
- **Worktree**: <absolute path to worktree>
```

### 10. Notify the user and stop

Tell the user:

> **PR <X> of <total> is ready for review:** <PR link>
>
> - <brief summary of what was implemented>
> - Files changed: <list>
>
> **Next steps:**
> - `/safe-check-review <plan file>` — check for reviewer feedback and address it
> - `/resume-plan <plan file>` — merge this PR and continue to the next one

Then **stop**. Do NOT continue to the next PR.

## Repo-specific gotchas

- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- **CI**: Do NOT wait for CI checks to pass before merging. Merge immediately.
- **Bun PATH**: Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
- **Imports**: All imports use `.js` extensions (NodeNext module resolution).
- **Project structure**: Bun + TypeScript project. Code is in `assistant/`.

## Important

- .private/UNREVIEWED_PRS.md is written to by other processes. Read before writing, verify after writing. This file is gitignored.
- .private/safe-plan-state/ is gitignored.
