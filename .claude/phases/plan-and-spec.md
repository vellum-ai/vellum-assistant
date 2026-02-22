## Plan & Spec

**If `--skip-plan` was passed**, skip issue creation. Instead:

1. Fetch existing "Ready" issues from the project board and use those as the milestones.
2. Identify the project-level issue (the epic). Look for an open issue in "In Progress" status that references milestones, or ask the user to provide the project issue number. This is required for the final phase.
3. Proceed to the next phase with the fetched milestones.

**Otherwise:**

1. Analyze the feature description with extended thinking. Consider:
   - What the feature requires architecturally
   - How it fits into the existing codebase
   - What the logical milestones are (ordered by dependency)
   - What can be parallelized

2. Create a **project-level issue** -- the epic/umbrella for this feature. Assign it to the current GitHub user:

```bash
GH_USERNAME=$(gh api user --jq '.login')
gh issue create --assignee "$GH_USERNAME" --title "<Feature Title>" --body "$(cat <<'EOF'
## Overview
<what this feature does>

## Goals
- <goal 1>
- <goal 2>

## Non-goals
- <explicit non-goal>

## Approach
<high-level implementation approach>

<EXTRA_EPIC_FIELDS>

## Milestones
- [ ] M1: <title>
- [ ] M2: <title>
- ...
EOF
)"
```

Replace `<EXTRA_EPIC_FIELDS>` with any mode-specific fields. For safe-blitz, include:
```
## Feature branch
`<feature-branch-name>`
```
For blitz, remove the placeholder entirely.

3. Create **milestone issues** (M1, M2, ...) -- one per PR-sized chunk of work. Assign to the same GitHub user:

```bash
gh issue create --assignee "$GH_USERNAME" --title "M1: <milestone title>" --body "$(cat <<'EOF'
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
# Project-level (epic) issue -> in-progress
.claude/gh-project add-issue <epic-issue-number> --status in-progress

# Milestone issues -> ready (repeat for each)
.claude/gh-project add-issue <milestone-issue-number> --status ready
```

5. **Present the plan to the user for approval.** Show:
   - The project-level issue link
   - A numbered list of milestones with their issue links and dependency order
   - Any mode-specific details (e.g., feature branch name for safe-blitz)
   - Ask: "Proceed with execution?"

   Do NOT continue until the user confirms.
