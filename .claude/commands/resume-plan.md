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

```bash
cd <worktree>/assistant && export PATH="$HOME/.bun/bin:$PATH" && bunx tsc --noEmit
```

Fix any failures before proceeding.

#### 8d. Commit and push

```bash
cd <worktree>
git add -A
git commit -m "$(cat <<'EOF'
<commit message>

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
git push -u origin HEAD
```

#### 8e. Create PR (do NOT merge)

```bash
gh pr create --base main --title "<title from plan>" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

Part of plan: <plan filename> (PR <X> of <total>)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

#### 8f. Add to unreviewed list

Read `.private/UNREVIEWED_PRS.md`, append the new PR link, write it back.

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

- **Bun PATH**: Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
- **Imports**: All imports use `.js` extensions (NodeNext module resolution).
- **Project structure**: Bun + TypeScript project. Code is in `assistant/`.

## Important

- .private/UNREVIEWED_PRS.md is written to by other processes. Read before writing, verify after writing. This file is gitignored.
- .private/safe-plan-state/ is gitignored.
