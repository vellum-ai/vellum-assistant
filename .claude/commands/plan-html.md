Create or refresh a rollout plan and a companion friendly HTML view.

The user passed: `$ARGUMENTS`

If `$ARGUMENTS` is empty, stop and ask for a plan name/topic. Example:
`/plan-html dashboard onboarding`.

## Goal

Produce plan artifacts in `.private/plans/` that are easy to execute and easy to review:

1. A canonical markdown plan (`.md`) for implementation workflows.
2. A self-contained, polished HTML plan (`.html`) for human-friendly review.

## Steps

### 1. Resolve plan filename

Convert `$ARGUMENTS` into a stable filename slug:
- Upper snake case with `.md` / `.html` suffix.
- Example: `dashboard onboarding` -> `DASHBOARD_ONBOARDING.md` and `DASHBOARD_ONBOARDING.html`.

If the user explicitly provides a filename, honor it.

### 2. Load existing context first

- If `.private/plans/<name>.md` exists, read it and update in place.
- If `.private/plans/<name>.html` exists, read it and refresh it to match the markdown plan.
- Keep existing product decisions unless the user asked to change them.

### 3. Write the markdown plan

Create/update `.private/plans/<name>.md` with:
- Objective and primary outcomes.
- Product requirements.
- Scope decisions and guardrails.
- PR sequence overview table.
- Detailed PR sections (branch, title, scope, files, steps, validation, acceptance).
- Final acceptance checklist.

Keep PRs small and sequenced with clear ownership boundaries.

### 4. Write the friendly HTML view

Create/update `.private/plans/<name>.html` as a self-contained file (no external assets) with:
- A strong hero summary.
- Quick nav anchors.
- Outcome cards.
- Task chips / key highlights.
- Roadmap table.
- Expandable PR detail cards.
- For each PR detail card, include a clear **Files to modify** section (paths listed explicitly).
- Final acceptance checklist.
- Responsive layout for desktop and mobile.

Design guidance:
- Intentional typography and spacing hierarchy.
- Distinct visual direction (not plain markdown render).
- Meaningful color system and card structure.
- Keep content faithfully aligned with the markdown source.

### 5. Validate parity

Before finishing:
- Confirm all PRs and acceptance criteria in HTML match markdown.
- Confirm each HTML PR card includes the corresponding “Files to modify” list.
- Confirm no stale sections from older versions remain.

### 6. Open the HTML for review

Run:
`open .private/plans/<name>.html`

Then report:
- The two file paths created/updated.
- A concise summary of what changed.

## Important

- The markdown plan is source-of-truth for execution workflows.
- The HTML plan must remain content-equivalent and review-friendly.
- `.private/` is gitignored; this command focuses on planning artifacts, not committed source changes.
