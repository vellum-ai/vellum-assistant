Execute a multi-PR rollout plan sequentially. Each PR in the plan is implemented and mainlined before moving to the next.

The user passed: `$ARGUMENTS`

If `$ARGUMENTS` is empty, stop and tell the user to provide the plan filename. Example: `/execute-plan BROWSER_PLAN.md`.

## Steps

### 1. Read the plan

Sanitize `$ARGUMENTS` by stripping any path separators (use only the basename). Then read `.private/plans/<sanitized name>`. If the file doesn't exist, stop and tell the user.

Parse the plan to identify the ordered list of PRs. Plans typically have numbered PR sections (e.g. "## PR 1", "## PR 2") each describing: branch name, title, scope, files to modify, implementation steps, tests to run, and acceptance criteria.

### 2. Determine starting point

Check which PRs have already been completed. Look at:
- The git log for commits/PRs that match earlier PR titles or branch names from the plan.
- Whether the files/changes described in earlier PRs already exist in the codebase.

Skip any PRs that are already done. Tell the user which PRs you're skipping and why.

### 3. Execute each remaining PR

For each PR in order:

#### 3a. Implement

Read the PR section carefully. Implement all the changes described:
- Create/modify the listed files according to the steps.
- Follow the project conventions (Bun + TypeScript, `.js` import extensions, NodeNext resolution).
- Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.

#### 3b. Validate

Run the tests and type-checks specified in the PR section. Fix any failures before proceeding.

#### 3c. Mainline

Ship the changes using the same workflow as `/mainline`:

1. Create a branch using the name from the plan (or derive one from the PR title).
2. Stage and commit with a descriptive message.
3. Push and create a PR with a title and summary matching the plan.
4. Read `.private/UNREVIEWED_PRS.md`, append the new PR link, write it back.
5. Merge immediately: `gh pr merge <N> --squash`.
6. Switch back to main and pull.

#### 3d. Report progress

After each PR is mainlined, tell the user:
- Which PR was completed (e.g. "PR 3 of 8 done").
- The PR link.
- A brief summary of what was shipped.

Then proceed to the next PR.

### 4. Archive the plan

After all PRs are mainlined, move the plan file to `.private/plans/archived/`.

Strip any path separators from `$ARGUMENTS` to use only the basename, and quote it to prevent word splitting or glob expansion:

```bash
PLAN_FILE="$(basename "$ARGUMENTS")"
mkdir -p .private/plans/archived
mv ".private/plans/$PLAN_FILE" ".private/plans/archived/$PLAN_FILE"
```

### 5. Completion

After all PRs are mainlined, tell the user the plan is fully executed. List all the PRs that were created with their links.

## Repo-specific gotchas

- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- **Bun PATH**: Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
- **Imports**: All imports use `.js` extensions (NodeNext module resolution).
- **Project structure**: Bun + TypeScript project. Code is in `assistant/`.

IMPORTANT: .private/UNREVIEWED_PRS.md is written to by other processes. Read before writing, verify after writing.
