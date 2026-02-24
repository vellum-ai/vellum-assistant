Run `/check-reviews` to triage pending PR reviews, then immediately `/swarm` to address any feedback that was found.

Arguments (optional): $ARGUMENTS

Parse positional arguments and flags (these are passed through to both `/check-reviews` and `/swarm`):

- **First argument** (optional): number of parallel workers (default: 12).
- **Second argument** (optional): maximum number of tasks to complete before shutting down.
- **`--namespace NAME`** (optional): namespace for scoping the sweep. Passed as `--namespace` to both `/check-reviews` (to filter PRs and prefix TODO items) and `/swarm` (to filter TODO items and namespace branches).

## Phase 1: Check reviews

Run the `/check-reviews` skill, passing `--namespace` if one was provided. Wait for it to complete and note how many "Address the feedback" items were added to `.private/TODO.md`.

If no items were added (all PRs were approved or still pending), report the results and stop — there's nothing to swarm on.

## Phase 2: Swarm on feedback

If feedback items were added, run the `/swarm` skill, passing through any arguments the user provided.

## Output

After both phases complete, print a combined summary:

| Phase         | Result                                      |
| ------------- | ------------------------------------------- |
| Check Reviews | _e.g., "3 PRs reviewed, 2 had feedback"_ |
| Swarm         | _e.g., "3 items addressed, 0 failed"_                          |
