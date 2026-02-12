Finalize a safe-blitz: merge the feature branch PR into main, close out the project issue, and clean up locally.

The user passed: `$ARGUMENTS`

If `$ARGUMENTS` is empty, auto-detect the feature branch PR (see Step 1). Example usage: `/safe-blitz-done`, `/safe-blitz-done 1136`, `/safe-blitz-done feature/vslider-restyle`.

## Parsing arguments

`$ARGUMENTS` can be:
- A PR number (e.g., `1136`)
- A branch name (e.g., `feature/vslider-restyle`)
- Empty (auto-detect)

## Step 1: Identify the PR

Use the following detection cascade. Stop at the first step that finds a match.

### 1a. Explicit argument

```bash
# If PR number provided:
gh pr view <number> --json number,title,url,headRefName,body,state

# If branch name provided:
gh pr list --head <branch-name> --base main --json number,title,url,headRefName,body,state
```

### 1b. Current branch

```bash
gh pr list --head $(git branch --show-current) --base main --json number,title,url,headRefName,body,state
```

### 1c. Open feature/* PRs targeting main

```bash
gh pr list --base main --state open --json number,title,url,headRefName,body,state
```

Filter to PRs whose `headRefName` starts with `feature/`.

### 1d. Project board — issues in "In Review" status

If no open feature PRs were found, check the project board for issues in "In Review" status. Safe-blitz sets the epic to "In Review" in Phase 6, so this catches cases where the PR might have been missed.

```bash
source .private/project-config.env

gh api graphql -f query='{
  node(id: "'"$GH_PROJECT_ID"'") {
    ... on ProjectV2 {
      items(first: 100) {
        nodes {
          id
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue {
              optionId
              name
            }
          }
          content {
            ... on Issue {
              number
              title
              body
              state
            }
          }
        }
      }
    }
  }
}'
```

Filter to items where the status `optionId` matches `$GH_STATUS_IN_REVIEW_ID` and the issue is still open. These are safe-blitz epics awaiting merge. Look at the issue body for the `Feature branch` section to extract the branch name, then find the corresponding PR.

### Resolution

- If exactly **one** candidate is found (from any step), use it automatically.
- If **multiple** candidates are found, list them and ask the user to pick one.
- If **none** are found, stop and tell the user there are no open safe-blitz PRs or in-review project items.

Extract the **feature branch name** and **PR number** for later steps.

## Step 2: Find the project issue

Look at the PR body for a `Closes #<number>` reference — that's the project-level (epic) issue.

If not found, ask the user for the project issue number.

## Step 3: Merge the PR

```bash
gh pr merge <pr-number> --squash
```

Wait for the merge to complete. Confirm with:

```bash
gh pr view <pr-number> --json state,mergedAt
```

## Step 4: Update project board status to Done

Source project config:

```bash
source .private/project-config.env
```

Find the project item for the epic issue and set status to Done:

```bash
ITEM_ID=""
CURSOR=""
while [ -z "$ITEM_ID" ]; do
  if [ -z "$CURSOR" ]; then
    AFTER_ARG=""
  else
    AFTER_ARG=", after: \"$CURSOR\""
  fi
  RESULT=$(gh api graphql -f query='{
    node(id: "'"$GH_PROJECT_ID"'") {
      ... on ProjectV2 {
        items(first: 100'"$AFTER_ARG"') {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            content { ... on Issue { number } }
          }
        }
      }
    }
  }')
  ITEM_ID=$(echo "$RESULT" | jq -r '.data.node.items.nodes[] | select(.content.number == <issue-number>) | .id')
  HAS_NEXT=$(echo "$RESULT" | jq -r '.data.node.items.pageInfo.hasNextPage')
  CURSOR=$(echo "$RESULT" | jq -r '.data.node.items.pageInfo.endCursor')
  if [ "$HAS_NEXT" != "true" ]; then break; fi
done

gh api graphql -f query='mutation {
  updateProjectV2ItemFieldValue(input: {
    projectId: "'"$GH_PROJECT_ID"'"
    itemId: "'"$ITEM_ID"'"
    fieldId: "'"$GH_STATUS_FIELD_ID"'"
    value: {singleSelectOptionId: "'"$GH_STATUS_DONE_ID"'"}
  }) { projectV2Item { id } }
}'
```

## Step 5: Close the project issue

```bash
gh issue close <project-issue-number>
```

## Step 6: Clean up local branch

```bash
git checkout main
git pull origin main
git branch -d <feature-branch-name>
```

If `-d` fails (unmerged warning), use `-D` since the PR was already squash-merged.

## Step 7: Report

Print a summary:

```
## Safe Blitz Done

**PR:** #<number> — <title> (<url>)
**Project issue:** #<epic-number> — closed
**Branch:** `<feature-branch-name>` — deleted locally

You're now on `main` with the latest changes.
```

## Repo-specific gotchas

- **gh pr view fields**: `merged` is NOT a valid --json field. Use `state` and `mergedAt`: `gh pr view <N> --json state,mergedAt,title,url`
- **Merge strategy**: This repo does NOT allow merge commits. Always use `gh pr merge <N> --squash`.
