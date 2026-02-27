## Repo-specific gotchas (include these in every agent prompt)

- **gh pr view fields**: `merged` is NOT a valid --json field. Use `state` and `mergedAt` instead: `gh pr view <N> --json state,mergedAt,title,url`
- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- **CI**: Wait for CI checks to pass before merging. Use `.claude/wait-ci <PR_NUMBER>` before `gh pr merge`. The `.claude/ship --merge` flag does this automatically.
- **No piping to tail/head**: `tail` and `head` may not be available in the shell. Don't pipe to them.
