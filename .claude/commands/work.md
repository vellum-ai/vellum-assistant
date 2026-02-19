Handle one task using this selection rule:

- If the user passed `$ARGUMENTS`, treat that as the task to handle.
- Otherwise, handle the first item in `.private/TODO.md`.

IMPORTANT: If the task is "Address the feedback on <PR URL>", first check if the PR has been merged already. If not, merge it immediately and continue with the task.

## Repo-specific gotchas

- **gh pr view fields**: `merged` is NOT a valid --json field. Use `state` and `mergedAt` instead: `gh pr view <N> --json state,mergedAt,title,url`
- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- **CI**: Do NOT wait for CI checks to pass before merging. Merge immediately.
- **No piping to tail/head**: `tail` and `head` may not be available in the shell. Avoid `cmd | tail -N`. Instead, run the command directly and let output truncate naturally, or use the Read tool on output files.
- **Bun PATH**: Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.

If it requires code changes:

- Check the codebase to make sure it's still relevant. It may have been addressed already by someone else, or the codebase may have changed so it's no longer relevant, in which case remove it from the .private/TODO.md list and provide a detailed explanation of why it can be removed.

If it's still relevant:

- Decide if it can be implemented in a single PR or if it's large and complex enough that you need to break it down into multiple PRs to keep it manageable.

If you need to break it down into multiple PRs:

- Replace the item in .private/TODO.md in-place with one item per sub-task you need to complete to implement the feature, and let me know that you've done this and wait for more instructions.
- If this task was addressing feedback on a previous PR, preserve the original PR reference in each sub-task so that the paper trail is maintained. Format each sub-task as: `- <sub-task description> (feedback from <original PR URL>)`

If you can implement it in a single PR:

- Create a PR for it using `.claude/ship`. Build the body with a heredoc so task text with special characters doesn't break quoting:

  ```bash
  PR_BODY=$(cat <<'BODY_EOF'
  ## Summary
  <1-3 bullet points>

  ## Task
  <the verbatim task — from $ARGUMENTS if provided, or the exact TODO item text>

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  BODY_EOF
  )
  .claude/ship --commit-msg "<message>" --title "<title>" --body "$PR_BODY" --base main --merge --track-unreviewed --pull-base
  ```

  Output the PR link.
- Append the link to only this new PR to .private/UNREVIEWED_PRS.md
- CRITICAL: Merge it immediately with `gh pr merge <N> --squash` and switch back to the main branch
- If this task was addressing feedback on a previous PR (either "Address the feedback on <PR URL>" or a sub-task with "(feedback from <PR URL>)"), leave a paper trail on the original PR:
  1. **Comment on the original PR** linking to the new PR: `gh pr comment <original-PR-number> --body "Addressed in <new-PR-URL>"`
  2. **Resolve all bot review threads**: `.claude/gh-review resolve-threads <original-PR-number> "Addressed in <new-PR-URL>"`

After you've handled the item:

- If the handled task exists in `.private/TODO.md`, remove that exact item from the list. Be very careful to not accidentally overwrite other changes or remove other items unless you're absolutely sure you're doing the right thing.
- Provide a detailed description of what you did.

IMPORTANT: .private/TODO.md and .private/UNREVIEWED_PRS.md are written to by other processes so make sure you read them before writing to them and after writing to them. Don't be alarmed if you see changes that you didn't make, but make sure your changes are persisted and you're not overwriting other changes. .private/TODO.md and .private/UNREVIEWED_PRS.md are gitignored.
