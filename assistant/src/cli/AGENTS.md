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

### ID and Key Arguments

Options that accept IDs, keys, or opaque identifiers must include a short note
explaining how to discover the value via another CLI command. Without this,
users and AI agents have no way to know what to pass.

**Bad:**

```ts
.option("--app-id <id>", "App ID (UUID)")
```

**Good:**

```ts
.option("--app-id <id>", "App ID (UUID) — run 'assistant oauth apps list' to find it")
```

Common discovery patterns:

| Argument type | Discovery command                                              |
| ------------- | -------------------------------------------------------------- |
| Provider key  | `assistant providers list`                                     |
| Connection ID | `assistant connections list` or `assistant connections status` |
| OAuth app ID  | `assistant oauth apps list`                                    |
| Contact ID    | `assistant contacts list`                                      |

### Error Messages

Every error message must be **actionable** — when a command fails, the user or
AI agent must know what to do next. Each error needs two components:

1. **What went wrong** — a clear description of the failure.
2. **What to do** — a specific CLI command or next step to resolve it.

**Bad:**

```ts
throw new Error("Connection not found");
```

**Good:**

```ts
throw new Error(
  `Connection "${id}" not found. Run 'assistant connections list' to see available connections.`,
);
```

Common error patterns:

| Failure                  | Suggested action                                              |
| ------------------------ | ------------------------------------------------------------- |
| Resource not found       | Suggest the `list` or `status` command for that resource type |
| Missing prerequisite     | Suggest the `create`, `register`, or `connect` command        |
| Ambiguous input          | List the available options and suggest a disambiguation flag  |
| Mutually exclusive flags | Name both conflicting flags and explain which to drop         |

### Deprecation Hygiene

When a command is removed, clean up completely:

1. **Remove all implementation code** — the command registration, handler, and
   any helper functions that only served the removed command.
2. **Remove test mocks and fixtures** — delete test files, mock data, and helper
   functions that only existed for the removed command.
3. **Update references** — search for string references to the old command in
   docs, skills, fixtures, help text, and comments. Update or remove them.
4. **No deprecation shims** — do not add shims that forward the old command to
   the new one unless there is a documented migration window with a specific
   removal date. Silent forwarding hides technical debt and confuses agents
   that discover both old and new commands in help output.
