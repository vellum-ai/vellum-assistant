Read the IDEAS.md file at .claude/IDEAS.md. The user wants to work on a batch of items in parallel using git worktrees.

Based on the items the user selects (or suggest a good batch if they don't specify), do the following:

1. Group the selected items into non-conflicting batches (items that touch the same files should be in the same batch, done sequentially within that batch).
2. For each batch, draft a detailed kickoff message that a fresh Claude Code session can use to implement the items autonomously. The message should include:
   - The reminder that this is a Bun + TypeScript project with code in `assistant/`, that `export PATH="$HOME/.bun/bin:$PATH"` is needed, and that imports use `.js` extensions (NodeNext resolution).
   - A numbered list of tasks in the order they should be done.
   - Enough context about the existing code (file paths, relevant APIs) that the session doesn't need to explore from scratch.
   - The instruction to commit each task separately and type-check after each change.
3. Tell the user the `scripts/worktree create <branch>` command to run for each batch.

Keep the kickoff messages practical and specific — not vague. Reference actual file paths and function names.
