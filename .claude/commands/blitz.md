Plan a feature end-to-end, create GitHub issues on the project board, swarm-execute them in parallel, sweep for review feedback, address it, and report.

The user passed: `$ARGUMENTS`

If `$ARGUMENTS` is empty, stop and tell the user to provide a feature description. Example: `/blitz Add WebSocket transport for daemon IPC`.

## Parsing flags

Extract these flags from `$ARGUMENTS` before treating the remainder as the feature description:

- `--auto` — skip the pause between rounds (default: pause and ask before sweep)
- `--workers N` — parallel worker count for swarm phases (default: 12)
- `--skip-plan` — skip planning; use issues already in the "Ready" column of the GH project

Everything after stripping flags is the **feature description**.

Read and follow `.claude/phases/namespace.md`.

Read and follow `.claude/phases/repo-gotchas.md`. Include these gotchas in every agent prompt.

## Phase 1: Project Setup

Read and follow `.claude/phases/project-setup.md`.

## Phase 2: Plan & Spec

Read and follow `.claude/phases/plan-and-spec.md`. For blitz mode, remove the `<EXTRA_EPIC_FIELDS>` placeholder entirely (no feature branch field).

## Phase 3: Populate TODO.md

Read and follow `.claude/phases/populate-todo.md`.

## Phase 4: Swarm

Read and follow the instructions in `.claude/commands/swarm.md` with these modifications:

- Pass the `--workers` count (or default: 12) as the first argument.
- Pass `--namespace <namespace>` to use the derived namespace for branch naming.
- **After each milestone task completes and its PR merges**, update the corresponding GitHub issue. Skip this for non-milestone tasks (e.g., "Address the feedback on ..." items from Phase 5 — those are PR-based and have no associated milestone issue):
  1. Set the project board status to "Done" and close the issue:

```bash
.claude/gh-project set-status <issue-number> done
gh issue close <issue-number>
```

- Everything else follows the standard swarm workflow (worktrees, conflict avoidance, TODO/DONE/UNREVIEWED tracking).

## Phase 5: Sweep

Read and follow `.claude/phases/sweep.md`. When it says "back to the Swarm phase", return to Phase 4 above. When it says "final phase", proceed to Phase 6.

## Phase 6: Report

1. Update the project-level issue status to "Done" and close it:

```bash
.claude/gh-project set-status <project-issue-number> done
gh issue close <project-issue-number>
```

3. Get the project board URL using the persisted project number:

```bash
gh project view "$GH_PROJECT_NUMBER" --owner "$GH_PROJECT_OWNER" --format json | jq -r '.url'
```

4. Print a final summary:

```
## Blitz Complete

**Feature:** <feature description>
**Project issue:** #<number> (<link>)
**Project board:** <board-url>

| #   | Milestone                          | Issue | PR   | Status |
| --- | ---------------------------------- | ----- | ---- | ------ |
| M1  | <title>                            | #10   | #15  | merged |
| M2  | <title>                            | #11   | #16  | merged |
| M3  | <title>                            | #12   | #17  | merged |

**Feedback PRs:** <count, if any>
```

## Important

Read and follow `.claude/phases/blitz-important.md`. Additionally:
- If an agent hits merge conflicts, tell it to rebase: `git pull --rebase origin main`.
