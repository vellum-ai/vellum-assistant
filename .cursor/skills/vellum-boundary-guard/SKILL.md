---
name: vellum-boundary-guard
description: Check Vellum Assistant architecture and package boundaries. Use when editing imports, moving code, adding endpoints, touching assistant/gateway/client/skill boundaries, or reviewing architecture-sensitive changes.
---

# Vellum Boundary Guard

## Package Import Boundaries

Enforce these boundaries:

- `assistant/` must not import from `gateway/` via relative paths.
- `gateway/` must not import from `assistant/` via relative paths.
- `assistant/` and `skills/` must not import from each other directly.
- Runtime code must not import from `meta/`.
- Shared cross-package logic belongs in `packages/`.

For tests that need behavior from another package, mock the boundary instead of importing real handlers.

## HTTP And IPC Boundaries

- Public inbound HTTP endpoints belong in `gateway/`.
- New CLI-to-assistant interactions should use Unix socket IPC through the existing IPC route pattern.
- Events from assistant runtime code should use the assistant event hub rather than new HTTP endpoints when possible.

## Security Ownership Boundaries

- Gateway owns trust rules and gateway security files.
- CES owns credential files.
- The assistant must not read gateway-owned directories directly.
- Clients must not read from the user's `~/.vellum` directory.
- Secrets must not be stored in workspace files.

## Skill Boundaries

First-party skills run as separate processes and should communicate through supported contracts. Do not bypass skill isolation with direct relative imports.

## Review Workflow

1. Search changed imports and new route registrations.
2. Identify any package-crossing dependency.
3. Decide whether the correct home is a package-local module, a shared `packages/` module, IPC, HTTP through gateway, or a skill contract.
4. If a violation exists, recommend the smallest boundary-preserving move.

## Verification

Prefer existing guard tests when available, then add focused tests for any new boundary rule or route pattern.
