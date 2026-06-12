---
name: vellum-user-facing-copy
description: Review Vellum Assistant user-facing copy, examples, docs, CLI output, UI strings, and assistant-facing release notes. Use when editing text users may read, including README files, SKILL.md files, CLI messages, route errors, update bulletins, and client UI labels.
---

# Vellum User-Facing Copy

## Terminology

Use "assistant" in user-facing text. "Daemon" is an internal implementation detail and should only appear in internal code, internal comments, file paths, or architecture explanations intended for maintainers.

When unsure, ask: would a user ever read this? If yes, say "assistant".

## Generic Examples

Never include real personal data in examples, fixtures, tests, docs, or commit messages.

Use:

- Names: `Alice`, `Bob`, `Example User`
- Emails: `user@example.com`, `alice@example.org`
- Phone numbers: `555-0100` through `555-0199`
- IDs: `user-123`, `org-abc`, `conv-xyz`

Avoid real names, personal emails, real phone numbers, account IDs, tokens, or private workspace paths.

## Release Notes

There is currently no release-note surfacing mechanism — the workspace-bulletin feature was removed. Do not add new release-note workspace migrations; the historical set is frozen.

## Error Messages

Good user-facing errors:

- explain what failed
- avoid exposing internals or secrets
- say what the user can do next when there is a clear action
- use consistent product terminology

Avoid stack traces, implementation-only vocabulary, and ambiguous "something went wrong" messages when a concrete cause is available.

## Review Workflow

1. Identify text users may read.
2. Check terminology, privacy, and clarity.
3. Check whether the copy implies unavailable or flagged behavior.
4. Preserve technical precision while removing internal jargon.
5. Recommend tests or snapshots when copy is part of a stable interface.
