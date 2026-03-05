# CLI Package — Agent Instructions

## Purpose

The `cli/` package (`@vellumai/cli`) manages the **lifecycle of Vellum assistant instances** — creating, starting, stopping, connecting to, and deleting them. Commands here operate on or across instances and typically require specifying which assistant to target.

This contrasts with `assistant/src/cli/`, where commands are scoped to a **single running assistant** and operate on its local state (config, memory, contacts, etc.).

## When a command belongs here vs `assistant/src/cli/`

| `cli/` (this package)                           | `assistant/src/cli/`                                |
| ----------------------------------------------- | --------------------------------------------------- |
| Operates on or across assistant instances       | Operates within a single assistant's workspace      |
| Manages lifecycle (create, start, stop, delete) | Manages instance-local state (config, memory, etc.) |
| Requires specifying which assistant to target   | Implicitly scoped to the running assistant          |
| Works without an assistant process running      | May require or start the daemon                     |

Examples: `hatch`, `wake`, `sleep`, `retire`, `ps`, `ssh` belong here. `config`, `contacts`, `memory` belong in `assistant/src/cli/`.

## Assistant targeting convention

Commands that act on a specific assistant should accept an assistant name or ID as an argument. When none is specified, default to the most recently created local assistant. Use `loadAllAssistants()` and `findAssistantByName()` from `lib/assistant-config` for resolution.

## Conventions

- Commands are standalone exported functions in `src/commands/`.
- Each command manually parses `process.argv.slice(3)` (no framework — keep it lightweight).
- Register new commands in the `commands` object in `src/index.ts` and add a help line.
- User-facing output uses `console.log`/`console.error` directly (no shared logger).
