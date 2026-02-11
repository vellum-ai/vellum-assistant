Plan a feature end-to-end, create GitHub issues on the project board, swarm-execute them in parallel, sweep for review feedback, address it, and report.

The user passed: `$ARGUMENTS`

If `$ARGUMENTS` is empty, stop and tell the user to provide a feature description. Example: `/blitz Add WebSocket transport for daemon IPC`.

## Parsing flags

Extract these flags from `$ARGUMENTS` before treating the remainder as the feature description:

- `--auto` — skip the pause between rounds (default: pause and ask before sweep)
- `--workers N` — parallel worker count for swarm phases (default: 3)
- `--skip-plan` — skip planning; use issues already in the "Ready" column of the GH project

Everything after stripping flags is the **feature description**.

## Repo-specific gotchas (include these in every agent prompt)

- **gh pr view fields**: `merged` is NOT a valid --json field. Use `state` and `mergedAt` instead: `gh pr view <N> --json state,mergedAt,title,url`
- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
- **No piping to tail/head**: `tail` and `head` may not be available in the shell. Don't pipe to them.
- **Bun PATH**: Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
- **Imports**: All imports use `.js` extensions (NodeNext module resolution).
- **Project structure**: Bun + TypeScript project. Code is in `assistant/`.

## Phase 1: Project Setup

1. Source `.private/project-config.env` to load the project board IDs:

```bash
source .private/project-config.env
```

This provides: `GH_PROJECT_NUMBER`, `GH_PROJECT_OWNER`, `GH_PROJECT_ID`, `GH_STATUS_FIELD_ID`, `GH_STATUS_TRIAGE_ID`, `GH_STATUS_READY_ID`, `GH_STATUS_IN_PROGRESS_ID`, `GH_STATUS_IN_REVIEW_ID`, `GH_STATUS_DONE_ID`.

2. If `.private/project-config.env` doesn't exist, create the project and config:

```bash
# Create the project
PROJECT_URL=$(gh project create --owner "@me" --title "vellum-assistant" --format json | jq -r '.url')
PROJECT_NUMBER=$(echo "$PROJECT_URL" | grep -oE '[0-9]+$')

# Get the project node ID
GH_PROJECT_ID=$(gh project view "$PROJECT_NUMBER" --owner "@me" --format json | jq -r '.id')

# Add Status field (single select) with standard columns
gh api graphql -f query='mutation {
  addProjectV2SingleSelectField(input: {
    projectId: "'"$GH_PROJECT_ID"'"
    name: "Status"
    options: [{name:"Triage",color:GRAY},{name:"Ready",color:BLUE},{name:"In Progress",color:YELLOW},{name:"In Review",color:ORANGE},{name:"Done",color:GREEN}]
  }) { projectV2SingleSelectField { id options { id name } } }
}'
```

Then query the field and option IDs and write them to `.private/project-config.env` in the same format shown above. Include `GH_PROJECT_NUMBER` (the human-readable number from the project URL).

## Phase 2: Plan & Spec

**If `--skip-plan` was passed**, skip issue creation. Instead:

1. Fetch existing "Ready" issues from the project board and use those as the milestones.
2. Identify the project-level issue (the epic). Look for an open issue in "In Progress" status that references milestones, or ask the user to provide the project issue number. This is required — Phase 6 needs it to close out the project.
3. Proceed to Phase 3 with the fetched milestones.

**Otherwise:**

1. Analyze the feature description with extended thinking. Consider:
   - What the feature requires architecturally
   - How it fits into the existing codebase
   - What the logical milestones are (ordered by dependency)
   - What can be parallelized

2. Create a **project-level issue** — the epic/umbrella for this feature:

```bash
gh issue create --title "<Feature Title>" --body "$(cat <<'EOF'
## Overview
<what this feature does>

## Goals
- <goal 1>
- <goal 2>

## Non-goals
- <explicit non-goal>

## Approach
<high-level implementation approach>

## Milestones
- [ ] M1: <title>
- [ ] M2: <title>
- ...
EOF
)"
```

3. Create **milestone issues** (M1, M2, ...) — one per PR-sized chunk of work:

```bash
gh issue create --title "M1: <milestone title>" --body "$(cat <<'EOF'
## Context
Part of #<project-issue-number>: <feature title>

## Implementation
- <specific file changes>
- <functions to add/modify>
- <tests to write>

## Dependencies
- Depends on: <none | M<n>>
- Blocks: <M<n> | none>
EOF
)"
```

4. Add all issues to the GH project board and set their statuses:

```bash
# Add issue to project (repeat for each issue)
ITEM_ID=$(gh api graphql -f query='mutation {
  addProjectV2ItemById(input: {
    projectId: "'"$GH_PROJECT_ID"'"
    contentId: "<issue-node-id>"
  }) { item { id } }
}' --jq '.data.addProjectV2ItemById.item.id')

# Get the issue node ID first:
# gh api repos/vellum-ai/vellum-assistant/issues/<number> --jq '.node_id'

# Set status (use GH_STATUS_IN_PROGRESS_ID for project issue, GH_STATUS_READY_ID for milestones)
gh api graphql -f query='mutation {
  updateProjectV2ItemFieldValue(input: {
    projectId: "'"$GH_PROJECT_ID"'"
    itemId: "'"$ITEM_ID"'"
    fieldId: "'"$GH_STATUS_FIELD_ID"'"
    value: {singleSelectOptionId: "'"$GH_STATUS_READY_ID"'"}
  }) { projectV2Item { id } }
}'
```

5. **Present the plan to the user for approval.** Show:
   - The project-level issue link
   - A numbered list of milestones with their issue links and dependency order
   - Ask: "Proceed with execution?"

   Do NOT continue until the user confirms.

## Phase 3: Populate TODO.md

1. Read `.private/TODO.md` (preserve existing items).
2. Prepend milestone issues as TODO items at the top:

```
- M1: <title> (#<issue-number>)
- M2: <title> (#<issue-number>)
...
```

3. Write the updated file back. Verify the write preserved existing items.

## Phase 4: Swarm

Read and follow the instructions in `scripts/commands/swarm.md` with these modifications:

- Pass the `--workers` count (or default 3) as the first argument.
- **After each milestone task completes and its PR merges**, update the corresponding GitHub issue. Skip this for non-milestone tasks (e.g., "Address the feedback on ..." items from Phase 5 — those are PR-based and have no associated milestone issue):
  1. Set the project board status to "Done":

```bash
# Get the item ID for this issue on the project board
ITEM_ID=$(gh api graphql -f query='{
  node(id: "'"$GH_PROJECT_ID"'") {
    ... on ProjectV2 {
      items(first: 100) {
        nodes {
          id
          content { ... on Issue { number } }
        }
      }
    }
  }
}' --jq '.data.node.items.nodes[] | select(.content.number == <issue-number>) | .id')

# Update status to Done
gh api graphql -f query='mutation {
  updateProjectV2ItemFieldValue(input: {
    projectId: "'"$GH_PROJECT_ID"'"
    itemId: "'"$ITEM_ID"'"
    fieldId: "'"$GH_STATUS_FIELD_ID"'"
    value: {singleSelectOptionId: "'"$GH_STATUS_DONE_ID"'"}
  }) { projectV2Item { id } }
}'
```

  2. Close the GitHub issue:

```bash
gh issue close <issue-number>
```

- Everything else follows the standard swarm workflow (worktrees, conflict avoidance, TODO/DONE/UNREVIEWED tracking).

## Phase 5: Sweep

1. Unless `--auto` was passed, pause and ask the user: **"Initial swarm complete. Run sweep for review feedback?"**
   - If the user declines, skip to Phase 6.

2. Run the check-reviews workflow by reading and following `scripts/commands/check-reviews.md`.

3. After check-reviews completes, read `.private/TODO.md`:
   - If new "Address the feedback" items were added, run another swarm pass (back to Phase 4).
   - If no new feedback items, proceed to Phase 6.

4. If `--auto` was passed, skip the pause and run the sweep automatically. Still loop back to Phase 4 if feedback items were added.

## Phase 6: Report

1. Update the project-level issue status to "Done" on the GH project board (same GraphQL pattern as Phase 4).

2. Close the project-level issue:

```bash
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

- `.private/TODO.md`, `.private/DONE.md`, and `.private/UNREVIEWED_PRS.md` are written to by other processes. Always read before writing, verify after writing. These files are gitignored.
- Don't sleep for more than 15 seconds at a time while waiting for agents to finish.
- If an agent reports failure, put the item back in TODO.md and note the failure.
- If an agent hits merge conflicts, tell it to rebase: `git pull --rebase origin main`.
- Use `scripts/worktree` for isolation (same as swarm).
