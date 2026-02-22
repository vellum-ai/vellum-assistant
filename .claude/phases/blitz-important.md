## Important

- `.private/TODO.md` and `.private/UNREVIEWED_PRS.md` are written to by other processes. Always read before writing, verify after writing. These files are gitignored.
- Don't sleep for more than 15 seconds at a time while waiting for agents to finish.
- If an agent reports failure, put the item back in TODO.md and note the failure.
- Use `.claude/worktree` for isolation (same as swarm).
