You are reporting a bug or feature request as a GitHub issue.

The user's report: $ARGUMENTS

## Step 1: Gather context

If `$ARGUMENTS` is empty or vague, ask the user to describe:
- What happened (or what they want)
- Steps to reproduce (for bugs)
- Expected vs actual behavior (for bugs)
- Why this matters / use case (for feature requests)

If `$ARGUMENTS` is clear enough, proceed directly. Bias toward filing quickly — don't over-interrogate. If the user provides a screenshot or paste, that's often enough context.

## Step 2: Classify and route

Determine whether this is a **Bug** or **Feature Request** based on the description.

Route to the appropriate GitHub repository:

| Domain | Repository |
|--------|------------|
| Default / anything related to the Vellum assistant app | vellum-ai/vellum-assistant |

If the domain is ambiguous, default to **vellum-ai/vellum-assistant**. As new repos are added, update this table.

## Step 3: Check if already implemented

For feature requests that describe migrations, refactors, or architectural changes, **search the codebase first** before creating an issue. Use the Explore agent or Grep/Glob tools to check whether the requested work has already been done. Look for:

- Relevant code in the expected location (e.g., if the request is "move X to Y", check if X already exists in Y)
- Recent commits or PR references related to the request
- Comments or documentation describing the completed work

If the work is already done, tell the user it's already implemented, cite the evidence (file paths, commit hashes, PRs), and **do not create an issue**. Skip to Step 5.

## Step 4: Search for duplicates

Search existing GitHub issues for potential duplicates:

```bash
gh issue list -R <repo> --search "<relevant keywords>" --state all
```

Try 2-3 different keyword variations to be thorough. Search across both open and closed issues.

## Step 5a: If a duplicate or closely related issue exists

1. **Tell the user** which issue(s) you found and why you think they match.
2. **Add a comment** to the existing issue:
   ```bash
   gh issue comment <number> -R <repo> --body "<comment>"
   ```
   Include:
   - That this came from a Claude Code session
   - The new context, reproduction details, or use case
   - The date of this additional report
3. **Cross-link related issues** if you found multiple related-but-not-duplicate issues. Mention them in the comment body (e.g., "Related: #123, #456").
4. Tell the user the issue URL and current status so they know if it's already being worked on.

## Step 5b: If no duplicate exists

Create a new issue using `gh`:

```bash
gh issue create -R <repo> --title "<title>" --label "<label>" --body "<body>"
```

Use a HEREDOC for the body to preserve formatting.

### Labels
- Use `bug` for bugs, `enhancement` for feature requests
- Add additional labels if relevant (check existing labels with `gh label list -R <repo>`)

### Title
- Keep it short and descriptive (under 70 characters)
- Use imperative mood (e.g., "Add session-scoped permissions" not "Session-scoped permissions are needed")

### Description format

For **bugs**:
```markdown
## Problem
<What's happening — be specific>

## Steps to Reproduce
1. ...
2. ...

## Expected Behavior
<What should happen>

## Actual Behavior
<What actually happens>
```

For **feature requests**:
```markdown
## Problem
<What's painful or missing>

## Expected Behavior
<What the user wants to happen>
```

Keep descriptions concise. Don't pad with boilerplate.

### Tagging people

If the user mentions a team member or the issue is clearly in someone's domain, tag them:
- Use `gh issue edit <number> --add-assignee <username>` for assignees
- Or mention them with `@username` in the issue body or a follow-up comment
- Look up usernames: `gh api repos/<repo>/collaborators --jq '.[].login'`

### Cross-linking

If the issue is related to other recent issues, mention them in the body (e.g., "Related: #123"). The user may file several related issues in a session — look for opportunities to cross-link.

## Step 6: Report back

Tell the user:
- The issue URL
- Whether it was new or a duplicate
- Keep it brief — just the URL and a one-liner

## Step 7: Improve this command

After filing the issue, reflect on whether you learned something that should be captured in this command file for future runs. Proactively suggest edits to **this file** (`.claude/commands/report.md`) when:

- **Routing knowledge**: You routed an issue to a repo and the user confirmed or corrected the routing. Update the routing table in Step 2.
- **New labels**: The user asked you to use a label that doesn't exist in the instructions. Suggest adding it.
- **Tagging patterns**: You learned who owns what domain. Add it as a hint for future routing.
- **Description templates**: The user wanted a different structure or additional sections. Suggest updating the templates.
- **Duplicate search tips**: You found that certain keyword strategies work better for finding duplicates. Add them as hints.
- **New repos**: Issues are being routed to a new repository. Add it to the routing table.

When suggesting an edit, briefly explain what you'd change and why, then ask the user if they'd like you to update the file. If they approve, make the edit directly to this file. These improvements compound — each `/report` invocation makes the next one smarter.
