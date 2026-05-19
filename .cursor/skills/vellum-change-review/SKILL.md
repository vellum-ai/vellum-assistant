---
name: vellum-change-review
description: Review Vellum Assistant code changes for correctness, repo-specific quality rules, security risks, and missing validation. Use when reviewing diffs, preparing a PR, finishing implementation work, or when the user asks for a code review, quality pass, or pre-merge check in this repository.
---

# Vellum Change Review

## Review Stance

Prioritize bugs, behavioral regressions, security risks, migration gaps, broken package boundaries, and missing tests. Findings come before summaries. Avoid cosmetic feedback unless it affects correctness, maintainability, or user experience.

## Required Checks

1. Inspect the actual diff before judging the change.
2. Identify which packages are affected: `assistant`, `gateway`, `clients`, `cli`, `skills`, `packages`, or `meta`.
3. Check package boundaries:
   - `assistant` must not import from `gateway` by relative path.
   - `gateway` must not import from `assistant` by relative path.
   - `assistant` and `skills` must not import each other directly.
   - Runtime code must not import from `meta`.
4. Check persistence changes:
   - DB schema or data changes need append-only DB migrations.
   - Workspace path, format, or file changes need append-only workspace migrations.
   - Migrations must be idempotent and registered.
5. Check feature flags:
   - New assistant flags must be declared in `meta/feature-flags/feature-flag-registry.json`.
   - Default-disabled or rollout-only features must not ship user-facing release notes.
   - New flags may require a companion platform PR.
6. Check user-facing text:
   - User-facing copy should say "assistant", not "daemon".
   - Examples must use generic names, emails, phone numbers, and IDs.
7. Check LLM/provider usage:
   - LLM calls must go through the provider abstraction.
   - Comments and logs should use provider-agnostic wording.
8. Check tests and verification:
   - Look for focused tests covering changed behavior.
   - Prefer scoped `bun test path/to/test.ts`; never suggest broad `bun test`.
   - Suggest `bunx tsc --noEmit` when type-level risk is broad.

## Review Output

Use this structure:

```markdown
## Findings
- [severity] `path`: issue, impact, and concrete fix.

## Open Questions
- Any uncertainty that affects correctness or review confidence.

## Verification Gaps
- Tests or checks that still need to run.
```

If no issues are found, say that clearly and still mention residual risk or unrun checks.
