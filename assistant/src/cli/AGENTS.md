# Assistant CLI — Agent Instructions

## Purpose

Commands in `assistant/src/cli/` are scoped to a **single running assistant instance**. They operate on the assistant's local state — config, memory, contacts, trust rules, conversations, autonomy, etc. — and run within the context of the assistant's workspace.

This contrasts with `cli/`, which manages the **lifecycle of assistant instances** (create, start, stop, delete) and operates across instances. See `cli/AGENTS.md`.

## Scope

Commands here operate on a **single running assistant's** local state — config, memory, contacts, trust rules, conversations, autonomy, etc. They are implicitly scoped to the running assistant and may require or start the daemon.

For commands that manage the **lifecycle of assistant instances** (create, start, stop, delete), see `cli/AGENTS.md`.

Examples: `config`, `contacts`, `memory`, `autonomy`, `conversations` belong here. `hatch`, `wake`, `sleep`, `retire`, `ps`, `ssh` belong in `cli/`.

## Full CRUD for Resource Namespaces

Every namespace that manages a resource (schedules, contacts, tasks, …) must expose the full CRUD surface — create, get/list, update, delete — each wired to a daemon route. Intentional exceptions (e.g. create restricted to one mode) must be documented inline in the namespace help text so agents know the gap is deliberate. Partial surfaces are not a smaller scope, they are a hazard: when a CRUD verb is missing, the model bypasses the CLI and hand-writes SQLite rows instead.

## Conventions

- Commands use [Commander.js](https://github.com/tj/commander.js) and follow the `registerXCommand(program: Command)` pattern.
- Each command module exports a registration function that attaches subcommands to the program.
- Register new commands in `assistant/src/cli/program.ts` inside the `buildCliProgram()` function by importing and calling the registration function.
- Use `getCliLogger("cli")` for output (not raw `console.log`).
- When adding/removing/renaming assistant CLI commands or subcommands, update the gateway bash risk registry coverage in `gateway/src/risk/command-registry/commands/assistant.ts` (supported command paths + risk overrides) so permission prompts stay correct.

## Service calls — transport-based dispatch

CLI commands use one of two transport patterns depending on whether they need a running daemon:

- **`ipc`-tagged commands** call `cliIpcCall` from `../../ipc/cli-client.js`. They forward requests to the daemon over the IPC socket for state the daemon owns.
- **`local`-tagged commands** read or write workspace files directly (config, autonomy, completions, etc.) using the same config/store helpers the daemon uses internally. They do not require the daemon to be running.

Both transport classes avoid proxying through the gateway HTTP API. `ipc` commands reach the daemon directly via the socket; `local` commands bypass the daemon entirely. The transport tag is declared via `registerCommand({ transport, ... })` — see the "Transport tagging" section below.

## Transport tagging

Every command file declares its transport class via `registerCommand({ transport, ... })`
from `../lib/register-command.ts`. The three transport classes are:

| Class       | Rule                                                            | When to use                                 |
| ----------- | --------------------------------------------------------------- | ------------------------------------------- |
| `ipc`       | Reaches the daemon (over IPC, or in-process via a lazy import). | Commands that call the daemon               |
| `local`     | Touches only static workspace files / shell artifacts.          | Commands that work without a running daemon |
| `bootstrap` | Runs before the daemon is up (e.g. `assistant config init`).    | Pre-daemon setup                            |

The tag is descriptive metadata; keep it accurate so readers can tell at a
glance whether a command needs a running daemon.

## Anatomy of an `ipc` command

An `ipc`-tagged subcommand action parses argv, reaches the daemon — over
IPC for daemon-owned state, or by running a lazily-imported helper
in-process — and formats output. Prefer in-process where it saves an IPC
round-trip; prefer IPC when the daemon owns the state or a running
instance must do the work.

### Required shape

```ts
// assistant/src/cli/commands/foo.ts
import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
import { writeOutput } from "../output.js";

interface FooBarResponse {
  bars: { id: string; name: string }[];
}

export function registerFooCommand(program: Command): void {
  registerCommand(program, {
    name: "foo",
    transport: "ipc",
    description: "Manage foos",
    build: (foo) => {
      foo
        .command("bar")
        .description("List bars")
        .option("--baz <n>", "Filter by baz")
        .action(async (opts, cmd) => {
          const r = await cliIpcCall<FooBarResponse>("foo_bar", {
            baz: opts.baz,
          });
          if (!r.ok) return exitFromIpcResult(r);
          writeOutput(cmd, r.result);
        });
    },
  });
}
```

Then wire it from `program.ts` inside `buildCliProgram()`:

```ts
import { registerFooCommand } from "./commands/foo.js";
// ...
registerFooCommand(program);
```

### Rules

1. **Keep hoisted imports inside the CLI.** A command module's top-level
   (hoisted) imports are loaded on every `assistant …` invocation, so
   they must stay light. You may hoist Node/npm packages, modules within
   `assistant/src/cli`, and the shared non-daemon leaf zones `util/`,
   `ipc/` (the IPC client + socket path), `types/`, and `version`.
   Type-only imports (`import type …`) are always fine — they are erased
   and cost nothing at runtime.

   **Do not hoist imports of daemon functionality** — anything else
   outside `assistant/src/cli` (`runtime/`, `daemon/`, `persistence/`,
   `providers/`, `platform/`, `security/`, …). Hoisting it pulls the
   daemon's module graph into every CLI process and inflates its memory
   footprint. This is enforced by the `cli/no-daemon-internals` ESLint
   rule (`error`): a hoisted import that resolves outside the CLI tree and
   the leaf zones above fails lint. Lazy-import it instead (rule 2).

   Rare exception: an execution-free data leaf that is needed
   _synchronously_ at command registration (so it can't be a lazy
   `import()`) may stay hoisted behind a scoped
   `// eslint-disable-next-line cli/no-daemon-internals` with a comment
   explaining why. The only current case is `browser/operation-meta`, in
   `commands/browser.ts` (it drives synchronous subcommand generation and
   deliberately pulls no Playwright graph) and `commands/browser.help.ts`
   (which derives the declarative help from the same contract).

2. **Lazy-import daemon functionality inside the action.** Running daemon
   logic in-process is encouraged where it avoids an IPC round-trip (which
   otherwise adds main-process event-loop congestion). Reach that code
   with a dynamic import inside the action, so it loads only when the
   command actually runs:

   ```ts
   .action(async (opts) => {
     const { doTheThing } = await import("../../runtime/foo.js");
     await doTheThing(opts);
   });
   ```

3. **Always check `r.ok` before reading `r.result`.** `cliIpcCall`
   returns `CliIpcCallResult<T>` — either `{ ok: true, result }` or
   `{ ok: false, error, statusCode?, errorCode?, errorDetails? }`. Use
   `exitFromIpcResult(r)` to surface failure: it writes the error to
   stderr and exits with a code derived from the daemon-side
   `statusCode` (10 connect failure, 3 5xx, 2 4xx, 1 other).

4. **Output via `writeOutput(cmd, payload)`.** The shared helper writes
   JSON to stdout — compact with `--json`, pretty otherwise — and
   respects `--json` inherited from parent commands. Don't
   `console.log` results directly; that bypasses the convention and
   breaks downstream scripting.

### Anti-patterns

- ❌ Hoisting a daemon import — `import { x } from "../../runtime/foo.js"`
  at module top (caught by `cli/no-daemon-internals`). Lazy-import it
  inside the action instead so it loads only when the command runs.
- ❌ Bypassing `exitFromIpcResult` to format your own error output.
  The shared helper gives consistent exit codes across the surface so
  scripts can branch on them.
- ❌ Calling the gateway HTTP API (`fetch`, `axios`) from a CLI
  command. Reach the daemon over IPC or via a lazily-imported in-process
  helper; the gateway is for external clients.

## IPC operation IDs and routes

Every `ipc`-tagged subcommand action maps to exactly one operation
served by the daemon's IPC server. Two route surfaces exist:

- **Shared routes (`assistant/src/runtime/routes/`).** Served over both
  HTTP and IPC via the shared `ROUTES` array. Most domain routes live
  here — dual exposure is by design so the gateway can call the daemon
  over IPC instead of HTTP. See `assistant/AGENTS.md` for the routes /
  dispatch architecture.
- **IPC-only routes (`assistant/src/ipc/routes/`).** CLI/tool-specific
  methods with no HTTP counterpart (e.g. `wake_conversation`,
  `upsert_contact`). Use this surface only when the operation
  shouldn't be exposed over HTTP — when in doubt, default to the
  shared surface.

Operation IDs are `snake_case`. The conventional shape is
`<command>_<subcommand>` (`pending_list`, `oauth_connect`,
`cache_get`), but verb-first names are also used where they read more
naturally (`upsert_contact`, `wake_conversation`, `conversations_import`).
Pick the form that makes the operation obvious from the ID alone.

The route owns the request schema (zod), the business logic, and the
response shape. The CLI just forwards arguments and renders the
response. When you add a new CLI verb you're almost always also adding
(or extending) a route — see the PR template's CLI verb checklist.

## Canonical example

`commands/pending.ts` is the reference implementation. Read it first
when migrating a legacy command or unsure about a pattern.

- Clean error handling via `exitFromIpcResult`
- No daemon-internal imports

When migrating a legacy command, start by reading `pending.ts`.

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

### No Redundant Command Lists in `addHelpText`

Commander already renders a `Commands:` section from registered subcommands.
Never duplicate that list in `.addHelpText("after", ...)`. The `addHelpText`
block is for **supplementary context only** — domain notes, key concepts, and
examples. Repeating command names and descriptions wastes vertical space and
creates a maintenance burden (two places to update when a subcommand changes).

**Bad:**

```ts
oauth.addHelpText(
  "after",
  `
The oauth command group manages the full OAuth lifecycle:

  connect     Initiate an OAuth flow for a provider
  disconnect  Disconnect an OAuth provider
  ...
`,
);
```

**Good:**

```ts
oauth.addHelpText(
  "after",
  `
Providers are seeded on startup for built-in integrations. Apps and connections
are created during the OAuth authorization flow or can be managed manually via
their respective subcommands.

Examples:
  $ assistant oauth connect google
  $ assistant oauth status google
`,
);
```

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

| Argument type | Discovery command                   |
| ------------- | ----------------------------------- |
| Provider key  | `assistant oauth providers list`    |
| Connection ID | `assistant oauth status <provider>` |
| OAuth app ID  | `assistant oauth apps list`         |
| Contact ID    | `assistant contacts list`           |

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
  `Connection "${id}" not found. Run 'assistant oauth status <provider>' to see available connections.`,
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
