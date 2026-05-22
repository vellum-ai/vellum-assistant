---
name: vellum-pr-readiness
description: Prepare Vellum Assistant branches for review by checking git hygiene, PR scope, tests, docs, migrations, Linear linking, and companion repo needs. Use before creating a pull request, splitting work into PRs, or asking whether a branch is ready.
---

# Vellum PR Readiness

## Goal

Confirm the branch is reviewable, scoped, and verified before opening a PR. Prefer surfacing blockers over polishing summaries.

## Checklist

1. Inspect `git status` and identify unrelated changes, generated artifacts, deleted files, and untracked files.
2. Inspect staged and unstaged diffs before recommending a commit or PR.
3. Check for secrets:
   - Do not commit `.env`, credentials, tokens, private keys, or local workspace data.
   - `.env.example` is allowed only for placeholder values.
4. Check scope:
   - If the branch is too large, suggest splitting it into smaller, reviewable PR branches.
   - Separate unrelated UI, backend, migration, and infra changes when practical.
5. Check required follow-ups:
   - Migration needed for persisted data or workspace format changes.
   - Docs needed for significant architecture, service, or data-flow changes.
   - Companion `vellum-assistant-platform` PR needed for platform-affecting contracts or new feature flags.
6. Check Linear conventions:
   - Branch, commit body, and PR body should include the Linear issue ID when one exists.
   - Use `Closes JARVIS-123` for single final PRs.
   - Use `Part of JARVIS-123` for intermediate PRs in multi-PR plans.
7. Check verification:
   - Focused tests ran for changed behavior.
   - Typecheck ran when exported contracts or cross-package types changed.
   - Any skipped tests are explicitly called out.

## PR Body Template

Use this compact structure unless the user asks for another format:

```markdown
## Summary
- ...

## Test Plan
- ...

## Risk
- ...
```

Mention migrations, feature flags, rollout state, and companion PRs when relevant.

## Human Attention Comments

For non-routine changes, leave a PR comment calling out review focus and risk level. Skip this for routine low-risk changes.
