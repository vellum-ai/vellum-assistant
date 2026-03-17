# Assistant CLI — Agent Instructions

## Purpose

Commands in `assistant/src/cli/` are scoped to a **single running assistant instance**. They operate on the assistant's local state — config, memory, contacts, trust rules, conversations, autonomy, etc. — and run within the context of the assistant's workspace.

This contrasts with `cli/`, which manages the **lifecycle of assistant instances** (create, start, stop, delete) and operates across instances. See `cli/AGENTS.md`.

## Scope

Commands here operate on a **single running assistant's** local state — config, memory, contacts, trust rules, conversations, autonomy, etc. They are implicitly scoped to the running assistant and may require or start the daemon.

For commands that manage the **lifecycle of assistant instances** (create, start, stop, delete), see `cli/AGENTS.md`.

Examples: `config`, `contacts`, `memory`, `autonomy`, `conversations`, `doctor` belong here. `hatch`, `wake`, `sleep`, `retire`, `ps`, `ssh` belong in `cli/`.

## Conventions

- Commands use [Commander.js](https://github.com/tj/commander.js) and follow the `registerXCommand(program: Command)` pattern.
- Each command module exports a registration function that attaches subcommands to the program.
- Register new commands in `assistant/src/cli/program.ts` inside the `buildCliProgram()` function by importing and calling the registration function.
- Use `getCliLogger("cli")` for output (not raw `console.log`).

## Service calls — no gateway proxying

CLI commands must call the service/store layer directly — the same functions that the HTTP route handlers in `runtime/routes/` call. Do not proxy through the gateway HTTP API.

Both the gateway routes and the CLI are thin wrappers around the same shared business logic. For example, `runtime/routes/invite-routes.ts` delegates to `runtime/invite-service.ts`, and `runtime/routes/contact-routes.ts` delegates to `contacts/contact-store.ts`. CLI commands should import and call those same service modules directly.

This avoids a dependency on the gateway process being running and removes an unnecessary network hop.

## Help Text Standards

Every command at every level (namespace, subcommand, nested subcommand) must have
high-quality `--help` output optimized for AI/LLM consumption. Help text is a
primary interface — both humans and AI agents read it to understand what a command
does and how to use it.

### Requirements

1. **Top-level namespace**: Use `.description()` with a concise one-liner, then
   `.addHelpText("after", ...)` with:
   - A brief explanation of the domain and key concepts (e.g. naming conventions,
     storage model)
   - 3-4 representative examples covering the most common workflows

2. **Each subcommand**: Use `.description()` with a one-liner, then
   `.addHelpText("after", ...)` with:
   - An `Arguments:` block explaining each positional argument with its format
     and constraints
   - Behavioral notes (what happens on update vs create, what gets deleted, etc.)
   - 2-3 concrete `Examples:` showing exact invocations with realistic values

3. **Write for machines**: Help text is frequently parsed by AI agents to decide
   which command to run and how. Be precise about formats (`service:field`),
   constraints (required vs optional), and side effects. Avoid vague language
   like "configure settings" — say exactly what is configured and where it's stored.

4. **Use Commander's `.addHelpText("after", ...)`** for extended help. Don't
   cram everything into `.description()`.
