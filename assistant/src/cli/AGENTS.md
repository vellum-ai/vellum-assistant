# Assistant CLI — Agent Instructions

## Purpose

Commands in `assistant/src/cli/` are scoped to a **single running assistant instance**. They operate on the assistant's local state — config, memory, contacts, trust rules, sessions, autonomy, etc. — and run within the context of the assistant's workspace.

This contrasts with `cli/`, which manages the **lifecycle of assistant instances** (create, start, stop, delete) and operates across instances. See `cli/AGENTS.md`.

## When a command belongs here vs `cli/`

| `assistant/src/cli/` (this directory)               | `cli/`                                          |
| --------------------------------------------------- | ----------------------------------------------- |
| Operates within a single assistant's workspace      | Operates on or across assistant instances       |
| Manages instance-local state (config, memory, etc.) | Manages lifecycle (create, start, stop, delete) |
| Implicitly scoped to the running assistant          | Requires specifying which assistant to target   |
| May require or start the daemon                     | Works without an assistant process running      |

Examples: `config`, `contacts`, `memory`, `autonomy`, `sessions`, `doctor` belong here. `hatch`, `wake`, `sleep`, `retire`, `ps`, `ssh` belong in `cli/`.

## Conventions

- Commands use [Commander.js](https://github.com/tj/commander.js) and follow the `registerXCommand(program: Command)` pattern.
- Each command module exports a registration function that attaches subcommands to the program.
- Register new commands in `assistant/src/index.ts` by importing and calling the registration function.
- Use `getCliLogger("cli")` for output (not raw `console.log`).

## Service calls — no gateway proxying

CLI commands must call the service/store layer directly — the same functions that the HTTP route handlers in `runtime/routes/` call. Do not proxy through the gateway HTTP API.

Both the gateway routes and the CLI are thin wrappers around the same shared business logic. For example, `runtime/routes/invite-routes.ts` delegates to `runtime/invite-service.ts`, and `runtime/routes/contact-routes.ts` delegates to `contacts/contact-store.ts`. CLI commands should import and call those same service modules directly.

This avoids a dependency on the gateway process being running and removes an unnecessary network hop.
