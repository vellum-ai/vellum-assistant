---
name: vellum-test-selection
description: Select focused verification commands for Vellum Assistant changes. Use when deciding what tests, typechecks, lints, or smoke checks to run after editing this repository, especially before commits and pull requests.
---

# Vellum Test Selection

## Core Rule

Never run unscoped `bun test` in this repository. The full suite is large and can hang or time out. Choose focused tests based on changed files, then add typechecking when the change affects shared contracts or cross-package behavior.

## Setup

Before any Bun command:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

Run commands from the package directory that owns the changed files, usually `assistant`, `gateway`, `cli`, `clients/macos`, or `clients/tauri`.

## Selection Workflow

1. List changed files and group them by package.
2. For direct implementation/test pairs, run the matching test file.
3. For route, protocol, migration, IPC, provider, or schema changes, run nearby tests plus a package typecheck.
4. For shared TypeScript contracts, run tests for each consumer package that imports the contract.
5. For Swift or macOS client changes, prefer the existing platform-specific test command if one is already used in nearby docs or terminal history.
6. If a command is expected to be long-running, state that before running it.

## Common Commands

Assistant focused test:

```bash
cd assistant && bun test src/path/to/file.test.ts
```

Assistant test grep:

```bash
cd assistant && bun test src/path/to/file.test.ts --grep "case name"
```

Assistant typecheck:

```bash
cd assistant && bunx tsc --noEmit
```

Gateway focused test:

```bash
cd gateway && bun test src/path/to/file.test.ts
```

## Risk-Based Additions

Add typecheck when edits touch:

- exported TypeScript types or schemas
- route request/response shapes
- daemon/client protocols
- migrations and registry wiring
- package boundary imports
- provider abstractions
- feature flag registry or resolver code

Add migration tests when edits touch:

- `assistant/src/memory/migrations/`
- `assistant/src/workspace/migrations/`
- persisted workspace files
- database schema modules

## Reporting

When proposing or running verification, explain why each command is selected and note anything intentionally skipped.
