# Plugins

Plugins extend the assistant's default capabilibilities using hooks, tools, skills, and more.

If you're authoring a plugin against the current convention, this file
is your map. Read [`simple-memory/`](./simple-memory/) alongside, it's
the canonical reference implementation and exercises every wired
surface.

> Note: This README is meant to be _human-readable_ and is meant to be reviewed by other contributors,
> so that API conventions can be made intentionally.

---

## TL;DR

1. Create a directory `<root>/my-plugin/`.
2. Drop a `package.json` with a `name` and a `peerDependencies["@vellumai/plugin-api"]` semver range.
3. Add `hooks/<name>.ts` files (default export = hook function).
4. Add `tools/<name>.ts` files (default export = tool definition).
5. Install in your assistant with `assistant plugins install <name>` and it immediately registers on start.

---

## What a plugin can contribute today

The external plugin loader extends the assistant by wiring these contribution surfaces.

| Surface             | Directory         | Discovery                                     |
| ------------------- | ----------------- | --------------------------------------------- |
| Lifecycle hooks     | `hooks/<name>.ts` | filename → `plugin.hooks[<name>]`             |
| Model-visible tools | `tools/<name>.ts` | each file's default export → `plugin.tools[]` |

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
  internal helpers. Hooks and tools `import` from it normally.
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
  },
  "vellum": {}
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
- **`vellum`** - reserved for future use.

Any other `package.json` field passes through untouched — write
whatever your editor / linter / publish tooling expects.

---

## Public API surface — `@vellumai/plugin-api`

Plugins import types and constants from `@vellumai/plugin-api`. This
package is the only public-contract surface — anything not exported
from there is assistant-internal and subject to change.

For more on what these API exports, please see [here](https://github.com/vellum-ai/vellum-assistant/tree/main/assistant/src/plugin-api).

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
forwards whichever the chain settles on to the next plugin, and
ultimately to the assistant's agent loop.

### `init`

Fires once the first time the plugin is registered, whether that is on
assistant boot or on installation, after all other contributions by the
plugin.

```ts
// hooks/init.ts
import type { PluginInitContext } from "@vellumai/plugin-api";

export default async function init(
  ctx: PluginInitContext
): Promise<void> {
  // ctx.config            — your validated config (typed `unknown` for now)
  // ctx.credentials       — resolved credential values, keyed by manifest entry
  // ctx.logger            — pino child, bound to { plugin: <name> }
  // ctx.pluginStorageDir  — writable dir at <workspace>/plugins-data/<name>/
  // ctx.assistantVersion  — host semver string

  ctx.logger.info({ version: ctx.assistantVersion }, "init");
}
```

If `init` **throws**, the assistant raises `PluginExecutionError` and
aborts bootstrap for that plugin. Throw early if your plugin can't
start (missing creds, corrupt state, version mismatch you want to
hard-reject on).

### `shutdown`

Fires once when the assistant tears down the plugin (process exit,
explicit unload, etc.).

```ts
// hooks/shutdown.ts
import type { PluginShutdownContext } from "@vellumai/plugin-api";

export default async function shutdown(
  ctx: PluginShutdownContext,
): Promise<void> {
  // ctx.assistantVersion  — host semver string
}
```

Shutdown errors are **best-effort**: the assistant logs them with plugin
attribution and continues tearing down sibling plugins. Don't rely on
shutdown to do critical cleanup the user will notice, write durably
during normal operation instead.

### `user-prompt-submit`

Fires once per user turn, **after** the assistant assembles
`runMessages` and **immediately before** the messages flow into
`agentLoop.run()`, on every message submitted by the user.

```ts
// hooks/user-prompt-submit.ts
import type { UserPromptSubmitContext } from "@vellumai/plugin-api";

// In-place mutation style (return void):
export default async function userPromptSubmit(
  ctx: UserPromptSubmitContext,
): Promise<void> {
  // ctx.conversationId   — ID of the conversation associated with the User Message
  // ctx.originalMessages — Original set of messages before any transformation by loop or hooks.
  // ctx.latestMessages   — Set of messages to be fed into the agent
}
```

Multiple plugins' hooks chain in registration order — each plugin
sees the previous plugin's mutations.

The hook fires **exactly once per user turn**, at the primary
`agentLoop.run()` call site. The re-entry / retry / overflow-recovery
sites further down in the conversation agent loop deliberately do
**not** refire: they're not new user submissions.

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
import zod from "@vellumai/plugin-api";

const myToolInputSchema = zod.object({
  query: z.string({
    description: "The item to query",
  }),
});

type MyToolInputSchema = zod.infer<typeof myToolInputSchema>;

export default {
  description: "What the model sees in the tool catalog.",

  async execute(
    input: MyToolInputSchema,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    // input.query        - defined in the schema
    // ctx.conversationId — current conversation
    // ctx.workingDir     — assistant working directory
    // ctx.signal         — cooperative cancellation; check `.aborted` or
    //                      forward to fetch() / spawn() options
    // ctx.requestId      — per-turn request id for log correlation

    return { content: "...", isError: false };
  },
};
```

- **`execute(input, ctx)`** — the runtime invocation. Always return
  `{ content, isError }`.
- **`description`** — short string used for catalog grouping.

---

## Conventions

- **One contribution per file.** `hooks/init.ts` is one init hook.
  `tools/recall.ts` is one tool. No multi-export tricks.
- **Persistence goes to `ctx.pluginStorageDir`.** The assistant allocates
  `<workspace>/plugins-data/<plugin>/` per plugin and ensures it
  exists before `init` runs.
- **Logging through `ctx.logger`.** Don't roll your own pino instance
  — the runtime's child logger is bound to your plugin name.
- **Cooperative cancellation.** Long-running tools should check
  `ctx.signal?.aborted` or forward `ctx.signal` to `fetch` / `spawn`
  options.
