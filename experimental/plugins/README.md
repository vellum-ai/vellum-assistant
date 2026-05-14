# Experimental plugins

Plugin scaffolds that prove out the assistant plugin system before each
surface graduates into the runtime proper. Everything under this
directory is **experimental** — the surface set, manifest fields, and
discovery shape may all change before the framework stabilizes.

If you're authoring a plugin against the current convention, this file
is your map. Read [`simple-memory/`](./simple-memory/) alongside — it's
the canonical reference implementation and exercises every wired
surface.

---

## TL;DR

1. Create a directory `<root>/my-plugin/`.
2. Drop a `package.json` with a `name` (and ideally a
   `peerDependencies["@vellumai/plugin-api"]` semver range).
3. Add `hooks/<name>.ts` files (default export = hook function).
4. Add `tools/<name>.ts` files (default export = tool definition).
5. Boot the daemon — the external loader picks it up.

That's the entire registration story. **You never call a runtime
`register*` function** — file placement IS the registration.

---

## What a plugin can contribute today

The external plugin loader currently wires **two** contribution
surfaces. Additional surfaces are declared on the internal `Plugin`
interface but the external loader does not yet walk them — they're
available for first-party plugins under `assistant/src/plugins/defaults/`
that call `registerPlugin()` directly, and will land in the external
loader as each one stabilizes.

| Surface             | Directory         | Discovery                                     | External loader                     |
| ------------------- | ----------------- | --------------------------------------------- | ----------------------------------- |
| Lifecycle hooks     | `hooks/<name>.ts` | filename → `plugin.hooks[<name>]`             | ✅ wired                            |
| Model-visible tools | `tools/<name>.ts` | each file's default export → `plugin.tools[]` | ✅ wired                            |
| Skills              | —                 | —                                             | declared on `Plugin`, not wired yet |
| HTTP routes         | —                 | —                                             | declared on `Plugin`, not wired yet |
| Prompt injectors    | —                 | —                                             | declared on `Plugin`, not wired yet |
| Pipeline middleware | —                 | —                                             | declared on `Plugin`, not wired yet |

---

## Directory layout

```
my-plugin/
├── package.json               # Manifest (required)
├── README.md                  # Optional plugin docs
├── hooks/
│   ├── init.ts                # Bootstrap
│   ├── shutdown.ts            # Teardown
│   ├── user-prompt-submit.ts  # Per-turn message-list transform
│   └── <future-hook>.ts       # Forward-compat slot
├── tools/
│   ├── my_tool.ts             # Default export = tool definition
│   └── ...
└── src/                       # Internal modules (NOT walked by the loader)
    └── state.ts               # Shared state, helpers
```

Loader rules:

- **`.js` wins over `.ts`** when both exist for the same basename
  (compiled-binary semantics).
- **Missing surface directories are silently omitted** — plugins
  contribute only what's there.
- **A surface file present but missing a usable default export** is a
  hard failure for that plugin: the loader logs with attribution and
  skips it (other plugins keep loading).
- **`src/` (or any other directory)** is not walked. Use it for
  internal helpers — hooks and tools `import` from it normally.
- **Per-plugin import timeout** is 10s. Anything slower is treated as
  a load failure and the plugin is skipped.

---

## Manifest — `package.json`

The external loader reads three fields:

```json
{
  "name": "@you/my-plugin",
  "version": "0.0.1",
  "peerDependencies": {
    "@vellumai/plugin-api": "^0.8.0"
  }
}
```

- **`name`** _(required)_ — any npm-style name. The loader strips the
  scope (`@you/`) for the in-runtime plugin name. Duplicates fail
  registration.
- **`version`** — informational. Defaults to `"0.0.0"` if absent.
- **`peerDependencies["@vellumai/plugin-api"]`** — semver range
  checked against the running assistant version. Mismatch is **logged
  but does not block load today** (the install path is still in flux);
  once it stabilizes the mismatch will harden into a hard reject.
  Omitting the peerDep entirely is also logged.

Any other `package.json` field passes through untouched — write
whatever your editor / linter / publish tooling expects.

> **Note** — `PluginManifest` in the runtime types also declares
> `requiresCredential` and `requiresFlag`, but the external loader
> does not parse them from `package.json` yet. They wire up the
> credential resolution + feature-flag gating only for first-party
> plugins under `assistant/src/plugins/defaults/` today.

---

## Public API surface — `@vellumai/plugin-api`

Plugins import types and constants from `@vellumai/plugin-api`. This
package is the only public-contract surface — anything not exported
from there is daemon-internal and subject to change.

### Hook constants

```ts
import { HOOKS, type HookName } from "@vellumai/plugin-api";

HOOKS.INIT; // "init"
HOOKS.SHUTDOWN; // "shutdown"
HOOKS.USER_PROMPT_SUBMIT; // "user-prompt-submit"
```

Reach for `HOOKS.*` when your code references hook names. The runtime
accepts arbitrary strings for forward compat, but first-party code
(including your plugin) should always use the constant so the typo
surface stays at the constant declaration.

### Hook context types

| Type                      | Hook                 | Purpose                                                                         |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------- |
| `PluginInitContext`       | `init`               | Resolved config, credentials, logger, per-plugin storage dir, assistant version |
| `PluginShutdownContext`   | `shutdown`           | Assistant version (deliberately narrow)                                         |
| `UserPromptSubmitContext` | `user-prompt-submit` | `conversationId`, `originalMessages`, `latestMessages`                          |

### Tool types

| Type                  | Purpose                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ToolContext`         | What `execute(input, ctx)` receives: `conversationId`, `workingDir`, optional `signal`, `requestId`, `onOutput` |
| `ToolExecutionResult` | What `execute` returns: `content`, `isError`, optional `status`, optional `yieldToUser`                         |

### Logger

```ts
import type { PluginLogger } from "@vellumai/plugin-api";
```

Pino-compatible child logger handed to every `init` context. The
runtime binds it to `{ plugin: <name> }` for free — just call
`ctx.logger.info({ ... }, "message")`.

---

## Hooks

A hook is a function default-exported from `hooks/<name>.ts`. The
filename becomes the hook key. **One hook per file.**

The hook signature is:

```ts
type PluginHookFn<TCtx> = (ctx: TCtx) => Promise<TCtx | void>;
```

The polymorphic return shape means a hook can either **mutate `ctx`
in place and return `void`** or **return a new ctx** — the runtime
forwards whichever the chain settles on to the next plugin (and
ultimately to the daemon).

### `init`

Fires once when the daemon loads the plugin, after credentials are
resolved and before any tool/route contributions are registered.

```ts
// hooks/init.ts
import type { PluginInitContext } from "@vellumai/plugin-api";

export default async function init(ctx: PluginInitContext): Promise<void> {
  // ctx.config            — your validated config (typed `unknown` for now)
  // ctx.credentials       — resolved credential values, keyed by manifest entry
  // ctx.logger            — pino child, bound to { plugin: <name> }
  // ctx.pluginStorageDir  — writable dir at <workspace>/plugins-data/<name>/
  // ctx.assistantVersion  — host semver string

  ctx.logger.info({ version: ctx.assistantVersion }, "init");
}
```

If `init` **throws**, the daemon raises `PluginExecutionError` and
aborts bootstrap for that plugin. Throw early if your plugin can't
start (missing creds, corrupt state, version mismatch you want to
hard-reject on).

### `shutdown`

Fires once when the daemon tears down the plugin (process exit,
explicit unload, etc.).

```ts
// hooks/shutdown.ts
import type { PluginShutdownContext } from "@vellumai/plugin-api";

export default async function shutdown(
  _ctx: PluginShutdownContext,
): Promise<void> {
  // Flush state, close handles, unsubscribe listeners.
}
```

Shutdown errors are **best-effort**: the daemon logs them with plugin
attribution and continues tearing down sibling plugins. Don't rely on
shutdown to do critical cleanup the user will notice — write durably
during normal operation instead.

**Pattern**: many plugins need the logger and a store path at
shutdown but the context is intentionally narrow. Stash them at
init via a module-scoped state object — see
[`simple-memory/src/state.ts`](./simple-memory/src/state.ts) for the
canonical pattern.

### `user-prompt-submit`

Fires once per user turn, **after** the daemon assembles
`runMessages` (PKB / NOW / memory-graph injections, history repair,
overflow reduction, web-search-result strip — all already applied)
and **immediately before** the messages flow into `agentLoop.run()`.

```ts
// hooks/user-prompt-submit.ts
import type { UserPromptSubmitContext } from "@vellumai/plugin-api";

// In-place mutation style (return void):
export default async function userPromptSubmit(
  ctx: UserPromptSubmitContext,
): Promise<void> {
  ctx.latestMessages.length = 0;
  ctx.latestMessages.push(...ctx.originalMessages);
}

// Or functional style (return a new ctx):
//
// export default async function userPromptSubmit(
//   ctx: UserPromptSubmitContext,
// ): Promise<UserPromptSubmitContext> {
//   return { ...ctx, latestMessages: [...ctx.originalMessages] };
// }
```

- **`ctx.originalMessages`** — the user's original message list,
  declared `ReadonlyArray<Message>`. Snapshot it if you need a stable
  comparison point across the chain. Don't mutate it (TypeScript will
  yell; the runtime treats it as immutable).
- **`ctx.latestMessages`** — the working message list. Mutate in
  place OR return a new ctx with a fresh array. Whichever you do, the
  daemon threads the final value into `agentLoop.run()` as the
  run-messages argument.

Multiple plugins' hooks chain in registration order — each plugin
sees the previous plugin's mutations.

The hook fires **exactly once per user turn**, at the primary
`agentLoop.run()` call site. The re-entry / retry / overflow-recovery
sites further down in the conversation agent loop deliberately do
**not** refire — they're not new user submissions.

### Forward-compatible hooks

You can author `hooks/<future-name>.ts` today. The loader will
register it on `plugin.hooks[<future-name>]`, but the runtime won't
invoke it until a `runHook("<future-name>", ctx)` call site is added.
The `HOOKS` constant tracks **wired** hook names — anything outside
that const is best-effort scaffolding for forward-compat.

---

## Tools

A tool is a default-exported object from `tools/<name>.ts`. Plugin
tools land in the same registry as built-in tools and are visible to
the model through the standard tool catalog.

```ts
// tools/my_tool.ts
import type { ToolContext, ToolExecutionResult } from "@vellumai/plugin-api";

export default {
  name: "my_tool",
  description: "What the model sees in the tool catalog.",
  category: "plugin",
  defaultRiskLevel: "low" as const,

  getDefinition() {
    return {
      name: "my_tool",
      description: "Detailed description shown to the model.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "..." },
        },
        required: ["query"],
      },
    };
  },

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const query = String((input as { query?: unknown }).query ?? "").trim();
    if (query.length === 0) {
      return { content: "error: query must be non-empty", isError: true };
    }
    // ctx.conversationId — current conversation
    // ctx.workingDir     — daemon working directory
    // ctx.signal         — cooperative cancellation; check `.aborted` or
    //                      forward to fetch() / spawn() options
    // ctx.requestId      — per-turn request id for log correlation

    return { content: `searched: ${query}`, isError: false };
  },
};
```

Required object fields:

- **`name`** — what the model calls. Must be unique across the catalog
  (built-in tools + every plugin).
- **`getDefinition()`** — returns the schema the model sees:
  `{ name, description, input_schema }`.
- **`execute(input, ctx)`** — the runtime invocation. Always return
  `{ content, isError }`. Optional fields:
  - `status` — short display message (`"truncated"`, `"timed out"`).
  - `yieldToUser` — when `true`, the agent loop breaks after this
    result and hands control back to the user without another LLM
    call. Use for interactive surfaces (file uploads, action buttons)
    or `finish_turn`-style voluntary yields.

Recommended fields:

- **`category`** — `"plugin"` by convention.
- **`description`** — short string used for catalog grouping.
- **`defaultRiskLevel`** — the risk classifier seed (`"low"`,
  `"medium"`, `"high"`). Drives trust-rule lookups and the
  auto-approve gate.

See [`simple-memory/tools/`](./simple-memory/tools/) for the
canonical pattern (input parsing, error returns, cross-conversation
result scoping).

---

## Lifecycle in one diagram

```
daemon boot
  └─> external loader walks <pluginDir>/
        ├─> reads package.json, validates schema
        ├─> checks @vellumai/plugin-api peerDep against host version
        ├─> imports each hooks/<name>.ts default export
        ├─> imports each tools/<name>.ts default export
        └─> registerPlugin(plugin)
                │
                ├─> resolves credentials from manifest
                ├─> calls plugin.hooks[HOOKS.INIT](initContext)
                │       ↳ throws here halt this plugin's bootstrap
                ├─> wires plugin.tools[] into the tool catalog
                └─> plugin is live

per user turn
  └─> agent loop assembles runMessages (injections, repair, overflow)
        └─> runHook(HOOKS.USER_PROMPT_SUBMIT, ctx) on every registered plugin
              ↳ hooks chain in registration order
        └─> agentLoop.run(finalRunMessages, ...)

daemon shutdown
  └─> for each registered plugin (reverse order):
        ├─> unregister tools
        ├─> calls plugin.hooks[HOOKS.SHUTDOWN](shutdownContext)
        │       ↳ throws here are swallowed + logged
        └─> plugin teardown done
```

---

## Conventions

- **One contribution per file.** `hooks/init.ts` is one init hook.
  `tools/recall.ts` is one tool. No multi-export tricks.
- **State lives in `src/`.** Keep mutable / cached state out of hook
  files so init can set it and shutdown can flush it without
  re-receiving the runtime context.
- **Persistence goes to `ctx.pluginStorageDir`.** The daemon allocates
  `<workspace>/plugins-data/<plugin>/` per plugin and ensures it
  exists before `init` runs.
- **Logging through `ctx.logger`.** Don't roll your own pino instance
  — the runtime's child logger is bound to your plugin name.
- **Cooperative cancellation.** Long-running tools should check
  `ctx.signal?.aborted` or forward `ctx.signal` to `fetch` / `spawn`
  options.
- **Per-plugin isolation.** A plugin that throws at load, exceeds the
  10s import timeout, or fails any contribution registration is
  logged with attribution and skipped — no other plugin is affected.

---

## Reference plugin

[`simple-memory/`](./simple-memory/) — a durable memory + recall
plugin. It exercises every wired surface:

- `init` hook hydrates a JSONL file into in-process state
- `shutdown` hook flushes state back to disk
- `user-prompt-submit` hook demonstrates the in-place mutation form
  of `latestMessages` transformation
- `recall` + `remember` tools wired through a shared
  `src/state.ts` module

If you're writing your first plugin, copy `simple-memory/` and start
cutting.
