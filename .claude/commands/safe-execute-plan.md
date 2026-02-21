Execute a multi-PR rollout plan one PR at a time, pausing after each for human review.

The user passed: `$ARGUMENTS`

If `$ARGUMENTS` is empty, stop and tell the user to provide the plan filename. Example: `/safe-execute-plan BROWSER_PLAN.md`.

## Repo-specific gotchas

- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.

## Steps

### 1. Read the plan

Sanitize `$ARGUMENTS` by stripping any path separators (use `basename -- "$ARGUMENTS"`). Then read `.private/plans/<sanitized name>`. If the file doesn't exist, stop and tell the user.

Parse the plan to identify the ordered list of PRs. Plans typically have numbered PR sections (e.g. "## PR 1", "## PR 2") each describing: branch name, title, scope, files to modify, implementation steps, tests to run, and acceptance criteria.

Derive a **plan slug** from the filename (e.g. `BROWSER_PLAN.md` → `browser-plan`). This is used to namespace state and worktrees.

### 2. Check for existing state

Read `.private/safe-plan-state/<plan-slug>.md` if it exists. If it has an active PR, tell the user:

> This plan already has an active PR: <PR link>
> Run `/safe-check-review <plan file>` to check for feedback, or `/resume-plan <plan file>` to merge and continue.

Then stop.

### 3. Determine starting point

Check which PRs have already been completed. Look at:
- The git log for commits/PRs that match earlier PR titles or branch names from the plan.
- Whether the files/changes described in earlier PRs already exist in the codebase.

Skip any PRs that are already done. Tell the user which PRs you're skipping and why.

### 4. Implement the next PR

#### 4a. Create worktree

Derive a branch name from the plan's PR section (or from the PR title). Fetch latest main and create a worktree:

```bash
git fetch origin main
.claude/worktree create safe-plan/<plan-slug>/<pr-slug> origin/main
```

ALL work happens in the worktree — do NOT modify files in the main repo.

#### 4b. Implement

Read the PR section carefully. Implement all the changes described:
- Create/modify the listed files according to the steps.
- Follow the project conventions described in AGENTS.md.

#### 4c. Validate

**Do NOT run tests, type-checking (`tsc`), or linting unless the plan's PR section explicitly specifies validation steps.** These steps are slow and rarely catch issues for well-scoped changes.

#### 4d. Ship (do NOT merge)

**Run from the worktree root** (not `assistant/` or the main repo):

```bash
cd <worktree> && .claude/ship \
  --commit-msg "<commit message>" \
  --title "<title from plan>" \
  --body "## Summary
<1-3 bullet points>

Part of plan: <plan filename> (PR <X> of <total>)

<details>
<summary>Plan: <plan filename></summary>

<contents of .private/plans/<plan file>>

</details>

🤖 Generated with [Claude Code](https://claude.com/claude-code)" \
  --base main \
  --track-unreviewed
```

### 5. Human Attention Comment

Leave a comment on the PR highlighting where human review attention is most needed (see "Human Attention Comments on PRs" in AGENTS.md for format and guidelines):

```bash
gh pr comment <number> --body "<attention comment>"
```

### 6. Save state

```bash
mkdir -p .private/safe-plan-state
```

Write `.private/safe-plan-state/<plan-slug>.md` with this format:

```markdown
# Safe Plan State

- **Plan**: <plan filename>
- **Current PR**: <X> of <total>
- **PR URL**: <github PR URL>
- **PR Number**: <number>
- **Branch**: <branch name>
- **Worktree**: <absolute path to worktree>
```

### 7. Notify the user and stop

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

## Important

- .private/UNREVIEWED_PRS.md is written to by other processes. Read before writing, verify after writing. This file is gitignored.
- .private/safe-plan-state/ is gitignored.
- Multiple plans can run concurrently — each has its own state file and worktree namespace.
