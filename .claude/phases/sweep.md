## Sweep

This phase runs a **recursive sweep loop** that keeps checking for review feedback until all PRs related to the blitz are fully reviewed and all resulting action items are resolved — including transitive feedback (i.e., feedback on PRs that were themselves opened to address earlier feedback).

The blitz is NOT done until there is zero remaining feedback or transitive feedback relating to the blitz.

### Entry

1. Unless `--auto` was passed, pause and ask the user: **"Initial swarm complete. Run sweep for review feedback?"**
   - If the user declines, skip to the final phase.
2. If `--auto` was passed, skip the pause and begin the sweep loop automatically.

### Sweep loop

Repeat the following until the exit condition is met:

1. **Run check-reviews**: Read and follow `.claude/commands/check-reviews.md`, passing `--namespace <namespace>` so that only PRs from this blitz are checked and any TODO items added are prefixed with the namespace.

2. **Check for new action items**: After check-reviews completes, read `.private/TODO.md`:
   - If new `[<namespace>]`-prefixed "Address the feedback" items were added, go back to the Swarm phase to address them. When swarm finishes, return here and restart the sweep loop from step 1 (the new feedback PRs will be in UNREVIEWED_PRS.md and need their own reviews).

3. **Check for pending PRs**: If no new TODO items were added, read `.private/UNREVIEWED_PRS.md` and resolve each remaining PR's head branch name. The file contains only PR URLs (e.g., `https://github.com/<owner>/<repo>/pull/123`), not branch names, so you must query each PR to get its branch:

   For each PR URL still listed, extract the PR number and run:
   ```bash
   gh pr view <number> --json headRefName --jq '.headRefName'
   ```

   Check if any of the resolved head branches start with `swarm/<namespace>/`:
   - If namespaced PRs remain, **wait 60 seconds**, then restart the sweep loop from step 1. Reviewers may not have processed them yet. Log: `"Waiting for reviewers — <N> blitz PRs still pending review in UNREVIEWED_PRS.md..."`.
   - If no namespaced PRs remain, the exit condition is met.

### Exit condition

The sweep is complete when ALL of the following are true after a check-reviews pass:
- No new `[<namespace>]`-prefixed items were added to `.private/TODO.md`
- No PRs in `.private/UNREVIEWED_PRS.md` have a head branch (resolved via `gh pr view`) starting with `swarm/<namespace>/`

When the exit condition is met, proceed to the final phase.
