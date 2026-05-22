---
name: vellum-skill-authoring
description: Author and review first-party Vellum skills in the repository. Use when editing files under skills/, assistant bundled skills, skill manifests, tool definitions, SKILL.md files, or first-party skill portability and isolation behavior.
---

# Vellum Skill Authoring

## Scope

Use this for Vellum runtime skills in `skills/` and bundled assistant skills, not for Cursor Agent Skills under `.cursor/skills/`.

## Core Constraints

- First-party skills must be portable and isolated.
- `skills/` must not import from `assistant/`.
- `assistant/` must not import from `skills/`.
- Prefer skill processes and supported contracts over new daemon tool registrations.
- Avoid secrets, real personal data, and machine-specific paths in skill docs, tests, and fixtures.

## SKILL.md Quality Bar

Skill instructions should be concise and operational:

- State what the skill does and when to use it.
- Prefer concrete steps over broad advice.
- Keep user-facing terminology consistent.
- Use generic examples only.
- Avoid requiring hidden local state unless setup instructions create it.

## Tool And Script Review

When a skill adds scripts or tools:

1. Verify tool input/output contracts are explicit.
2. Check error handling and user-facing messages.
3. Confirm scripts can run in the skill process environment.
4. Avoid direct imports across isolation boundaries.
5. Add focused tests for parsing, contract handling, and failure cases.

## Catalog And Packaging

When adding or renaming skills, check the relevant catalog, manifest, bundled registry, or packaging path used by the runtime. Do not assume a `SKILL.md` file alone makes the skill available to users.

## Verification

Use focused tests around the changed skill, catalog entry, proxy bridge, or bundled registry. Add typecheck when contracts or generated manifests changed.
