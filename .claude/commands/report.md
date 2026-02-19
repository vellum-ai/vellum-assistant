You are reporting a bug or feature request on Linear.

The user's report: $ARGUMENTS

## Step 1: Gather context

If `$ARGUMENTS` is empty or vague, ask the user to describe:
- What happened (or what they want)
- Steps to reproduce (for bugs)
- Expected vs actual behavior (for bugs)
- Why this matters / use case (for feature requests)

If `$ARGUMENTS` is clear enough, proceed directly.

## Step 2: Classify and route

Determine whether this is a **Bug** or **Feature Request** based on the description.

Route to the appropriate Linear team based on the report's domain:

| Domain | Team |
|--------|------|
| Default / anything related to the Vellum assistant app | Jarvis |

If the domain is ambiguous, default to **Jarvis**. As new teams are added, update this table.

## Step 3: Check if already implemented

For feature requests that describe migrations, refactors, or architectural changes, **search the codebase first** before creating an issue. Use the Explore agent or Grep/Glob tools to check whether the requested work has already been done. Look for:

- Relevant code in the expected location (e.g., if the request is "move X to Y", check if X already exists in Y)
- Recent commits or PR references related to the request
- Comments or documentation describing the completed work

If the work is already done, tell the user it's already implemented, cite the evidence (file paths, commit hashes, PRs), and **do not create an issue**. Skip to Step 5.

## Step 4: Search for duplicates

Search existing issues on the target team for potential duplicates. Cast a wide net — use multiple keyword searches if needed to avoid false negatives.

```
list_issues(team: "<target team>", query: "<relevant keywords>")
```

Try 2-3 different keyword variations to be thorough. Check issues in ALL statuses (Backlog, Todo, In Progress, In Review) — not just open ones.

## Step 5a: If a duplicate or closely related issue exists

1. **Tell the user** which issue(s) you found and why you think they match.
2. **Add a comment** to the existing issue with:
   - Who is reporting this (mention it came from a Claude Code session)
   - The new context, reproduction details, or use case
   - Note the date of this additional report
   - Format example:
     ```
     **Additional report (YYYY-MM-DD)**
     Reported via Claude Code.

     <new context, repro steps, or use case details>
     ```
3. **Consider bumping priority**: If the existing issue is priority 4 (Low) or 0 (None), and this is a second+ report, suggest bumping to 3 (Normal). If it's already Normal and this is a 3rd+ report, suggest bumping to 2 (High). Ask the user before changing priority.
4. **Link related issues** if you found multiple related-but-not-duplicate issues.
5. Tell the user the issue identifier (e.g., JAR-XX) and current status so they know if it's already being worked on.

## Step 5b: If no duplicate exists

Create a new issue:

```
create_issue(
  team: "<target team>",
  title: "<concise, descriptive title>",
  description: "<structured description — see format below>",
  labels: ["Bug"] or ["Feature Request"],
  priority: <see priority guide>,
  state: "Backlog"
)
```

### Description format

For **bugs**:
```markdown
## Description
<What's happening>

## Steps to Reproduce
1. ...
2. ...

## Expected Behavior
<What should happen>

## Actual Behavior
<What actually happens>

## Context
- Reported via Claude Code on YYYY-MM-DD
- <any relevant environment or session context>
```

For **feature requests**:
```markdown
## Description
<What the user wants>

## Use Case
<Why this matters, what problem it solves>

## Context
- Reported via Claude Code on YYYY-MM-DD
- <any relevant context about current workarounds or pain points>
```

### Priority guide
- **1 (Urgent)**: System is down, data loss, blocking all users — almost never use this, ask user first
- **2 (High)**: Significant impact, no workaround, affecting multiple users
- **3 (Normal)**: Default for most bugs and feature requests
- **4 (Low)**: Minor annoyance, easy workaround exists, nice-to-have

Default to **3 (Normal)** unless there's a clear reason to go higher or lower.

## Step 6: Report back

Tell the user:
- The issue identifier (e.g., JAR-XX)
- Whether it was new or a duplicate
- Current status and priority
- If duplicate: how many times it's been reported (check comments for previous "Additional report" entries)

## Step 7: Improve this command

After filing the issue, reflect on whether you learned something that should be captured in this command file for future runs. Proactively suggest edits to **this file** (`.claude/commands/report.md`) when:

- **Routing knowledge**: You routed an issue to a team and the user confirmed or corrected the routing. Update the routing table in Step 2 with the new domain-to-team mapping.
- **New labels**: The user asked you to use a label that doesn't exist in the instructions. Suggest adding it to the label guidance.
- **Priority patterns**: You notice a pattern (e.g., "issues about data loss should always be High"). Suggest adding it to the priority guide.
- **Description templates**: The user wanted a different structure or additional sections. Suggest updating the templates.
- **Duplicate search tips**: You found that certain keyword strategies work better for finding duplicates. Add them as hints.
- **New teams**: A new team was created on Linear and issues are being routed there. Add it to the routing table.

When suggesting an edit, briefly explain what you'd change and why, then ask the user if they'd like you to update the file. If they approve, make the edit directly to this file. These improvements compound — each `/report` invocation makes the next one smarter.
