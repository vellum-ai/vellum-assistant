# CLI Package — Agent Instructions

## Purpose

The `cli/` package (`@vellumai/cli`) is the **multi-assistant management CLI**. It manages the lifecycle of Vellum assistant instances and provides commands to interact with them from outside any single assistant's workspace. Think of it as the "fleet management" layer.

This contrasts with `assistant/src/cli/`, which defines commands scoped to a **single assistant instance** — those commands run within the context of that assistant's workspace and operate on its local state (config, sessions, memory, trust rules, etc.).

## When a command belongs here vs `assistant/src/cli/`

| Belongs in `cli/`                               | Belongs in `assistant/src/cli/`                      |
| ----------------------------------------------- | ---------------------------------------------------- |
| Operates on or across assistant instances       | Operates within a single assistant's workspace       |
| Manages lifecycle (create, start, stop, delete) | Manages instance-local state (config, memory, trust) |
| Requires specifying which assistant to target   | Implicitly scoped to the running assistant           |
| Works without an assistant process running      | May require or start a daemon                        |

Examples: `hatch`, `wake`, `sleep`, `retire`, `ps`, `ssh` belong here. `config`, `sessions`, `memory`, `autonomy`, `doctor` belong in `assistant/src/cli/`.

## Assistant targeting convention

Commands that act on a specific assistant should accept an assistant name or ID as an argument. When no assistant is specified, default to the most recently created local assistant (i.e., "latest"). Use `loadAllAssistants()` and `findAssistantByName()` from `lib/assistant-config` for resolution.

## Architecture

The CLI acts as a thin entry point. When a command is not recognized locally, it resolves the `@vellumai/assistant` package and forwards the invocation to the assistant CLI (see `resolveAssistantEntry()` in `src/index.ts`). This means users get a unified `vellum <command>` surface without the CLI needing to bundle assistant internals.

## Conventions

- Commands are standalone exported functions in `src/commands/`.
- Each command manually parses `process.argv.slice(3)` (no framework — keep it lightweight).
- Register new commands in the `commands` object in `src/index.ts` and add a help line.
- User-facing output uses `console.log`/`console.error` directly (no shared logger).
