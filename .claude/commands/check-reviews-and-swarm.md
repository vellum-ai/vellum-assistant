Run `/check-reviews` to triage pending PR reviews, then immediately `/swarm` to address any feedback that was found.

Arguments (optional): $ARGUMENTS

Parse positional arguments and flags (these are passed through to `/swarm`):

- **First argument** (optional): number of parallel workers (default: 12).
- **Second argument** (optional): maximum number of tasks to complete before shutting down.
- **`--namespace NAME`** (optional): namespace for swarm branch naming (passed through to `/swarm`).

## Phase 1: Check reviews

Run the `/check-reviews` skill. Wait for it to complete and note how many "Address the feedback" items and "Fix CI failures" items were added to `.private/TODO.md`.

If no items were added (all PRs were approved or still pending, and no CI failures on main), report the results and stop — there's nothing to swarm on.

## Phase 2: Swarm on feedback

If feedback items were added, run the `/swarm` skill, passing through any arguments the user provided.

## Output

After both phases complete, print a combined summary:

| Phase         | Result                                      |
| ------------- | ------------------------------------------- |
| Check Reviews | _e.g., "3 PRs reviewed, 2 had feedback, 1 CI failure on main"_ |
| Swarm         | _e.g., "3 items addressed, 0 failed"_                          |
