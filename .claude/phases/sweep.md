## Sweep

1. Unless `--auto` was passed, pause and ask the user: **"Initial swarm complete. Run sweep for review feedback?"**
   - If the user declines, skip to the final phase.

2. Run the check-reviews workflow by reading and following `.claude/commands/check-reviews.md`, passing `--namespace <namespace>` so that only PRs from this blitz are checked and any TODO items added are prefixed with the namespace.

3. After check-reviews completes, read `.private/TODO.md`:
   - If new `[<namespace>]`-prefixed "Address the feedback" or "Fix CI failures" items were added, run another swarm pass (back to the Swarm phase).
   - If no new namespaced feedback items, proceed to the final phase.

4. If `--auto` was passed, skip the pause and run the sweep automatically. Still loop back to the Swarm phase if feedback items were added.
