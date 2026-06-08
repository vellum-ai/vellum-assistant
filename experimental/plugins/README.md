# Plugins

Plugins extend the assistant's default capabilities using hooks, tools,
skills, and more.

If you're authoring a plugin against the current convention, this file is
your map. Read [`simple-memory/`](./simple-memory/) alongside, it's the
canonical reference implementation and exercises every wired surface.

## Table of contents

- [TL;DR](#tldr)
- [What a plugin can contribute today](#what-a-plugin-can-contribute-today)
- [Directory layout](#directory-layout)
- [Manifest](#manifest--packagejson)
- [Public API surface](#public-api-surface--vellumaiplugin-api)
- [Hooks](#hooks)
- [Tools](#tools)
- [Marketplace — whitelisting external plugins](#marketplace--whitelisting-external-plugins)
- [Conventions](#conventions)

---

## TL;DR

1. Create a directory `<workspaceDir>/plugins/my-plugin/`.
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
│   ├── pre-model-call.ts      # Per-call request edit / output-defer
│   ├── post-tool-use.ts       # Per-tool-result transform
│   ├── stop.ts                # Per-run stop-boundary decision
│   ├── post-model-call.ts     # Per-call reply transform
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

export default async function init(ctx: PluginInitContext): Promise<void> {
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
  // ctx.prompt           — Submitted prompt text (after slash-command expansion), independent of any internal rewriting
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

### `pre-model-call`

Fires **immediately before each provider call** — once per model call within a
turn, including the follow-up calls after tool results. Because it runs for every
provider call (background, subagent, and compaction work can share a
conversation), a hook **must self-gate** on `ctx.callSite` / `ctx.conversationId`
before acting.

```ts
// hooks/pre-model-call.ts
import type { PreModelCallContext } from "@vellumai/plugin-api";

// In-place mutation style (return void):
export default async function preModelCall(
  ctx: PreModelCallContext,
): Promise<void> {
  // ctx.conversationId       — ID of the conversation the call belongs to
  // ctx.callSite             — call site ("mainAgent" for the user-facing reply)
  // ctx.systemPrompt         — system prompt about to be sent; replace to edit it
  // ctx.deferAssistantOutput — set true to suppress this turn's live text stream
  //                            (a `post-model-call` hook then emits the text)
  // ctx.logger               — turn-scoped; tag log fields with { plugin: <name> }
}
```

Multiple plugins' hooks chain in registration order — each sees the previous
hook's edits. Throwing is contained by the loop: the provider call proceeds with
the original request.

### `post-tool-use`

Fires once per tool result, **after** the tool returns and
**immediately before** the result joins the message history sent to the
provider. When several tools run in one turn, the hook fires once per
result, in tool-use order.

```ts
// hooks/post-tool-use.ts
import type { PostToolUseContext } from "@vellumai/plugin-api";

// In-place mutation style (return void):
export default async function postToolUse(
  ctx: PostToolUseContext,
): Promise<void> {
  // ctx.conversationId — ID of the conversation the tool ran on
  // ctx.toolResponse   — the tool result block; mutate `.content` to transform
  // ctx.maxInputTokens — model context window; derive a char budget as needed
  // ctx.logger         — turn-scoped; tag your log fields with { plugin: <name> }
}
```

Multiple plugins' hooks chain in registration order — each plugin sees
the previous plugin's mutations. The default `tool-result-truncate`
plugin contributes a hook here that tail-drops oversized output to fit
the context window; because defaults register first, it runs ahead of
user hooks.

### `stop`

Fires once per `run()` at the model's stop boundary — when the model
returns a response with **no tool calls** and the loop is about to hand
the turn back to the user. Refusals (a turn with no usable content) also
land here. Tool-calling turns never reach the hook.

```ts
// hooks/stop.ts
import type { StopContext } from "@vellumai/plugin-api";

// In-place mutation style (return void):
export default async function stop(ctx: StopContext): Promise<void> {
  // ctx.conversationId  — ID of the conversation the run belongs to
  // ctx.messages        — full conversation history; append a follow-up turn
  //                       here when continuing. To reason about just the
  //                       current response cycle, scope to the messages after
  //                       the last genuine user prompt
  // ctx.responseContent — content blocks of the stopping turn (no tool_use)
  // ctx.stopReason      — provider stop reason (e.g. "refusal", "end_turn")
  // ctx.decision        — seeded "stop"; set "continue" to re-query the model
  // ctx.logger          — turn-scoped; tag log fields with { plugin: <name> }
}
```

The hook decides the outcome by setting `ctx.decision`. The default is
`"stop"` (let the turn end). Setting it to `"continue"` forces another
loop iteration — when continuing, the hook must also append its follow-up
turn (e.g. a nudge `user` message) to `ctx.messages`, which the loop
threads into the next iteration. To abort with an error, throw; there is
no error decision value.

The loop owns the re-query budget: a hook may ask to continue every time,
but the loop stops once its retry cap is spent, so a continuing hook
cannot loop forever.

Multiple plugins' hooks chain in registration order — each sees the
previous hook's `decision` and `messages` mutations. The default
`empty-response` plugin contributes a hook here that re-queries the model
with a nudge when a turn comes back empty after tool use, or with a
refusal nudge on a first-call refusal; because defaults register first,
it runs ahead of user hooks.

### `post-model-call`

Fires for **each finalized assistant message** — once per model call, at the
message-complete boundary, before the message is persisted and (if deferred)
streamed-final. Unlike `stop`'s read-only `responseContent`, `ctx.content` is
**mutable**: the loop adopts the hook's result as the persisted and streamed
message. Fires on tool-bearing turns too (a reply can carry both text and
`tool_use`), so transform only the blocks you own and leave others — notably
`tool_use` — intact. Runs for every finalized message; **self-gate** on
`ctx.callSite` / `ctx.conversationId`.

```ts
// hooks/post-model-call.ts
import type { PostModelCallContext } from "@vellumai/plugin-api";

// In-place mutation style (return void):
export default async function postModelCall(
  ctx: PostModelCallContext,
): Promise<void> {
  // ctx.conversationId — ID of the conversation the message belongs to
  // ctx.callSite       — call site ("mainAgent" for the user-facing reply)
  // ctx.content        — finalized message content; transform text blocks and
  //                      leave tool_use (and other non-text blocks) intact
  // ctx.stopReason     — provider stop reason, when reported
  // ctx.logger         — turn-scoped; tag log fields with { plugin: <name> }
}
```

A `pre-model-call` hook can set `deferAssistantOutput` to suppress the live
stream; the loop then emits this hook's finalized text once. Multiple plugins'
hooks chain in registration order — each sees the previous hook's mutations.
Throwing is contained by the loop: the original content is kept.

### Forward-compatible hooks

You can author `hooks/<future-name>.ts` today. The loader will
register it on `plugin.hooks[<future-name>]`, but the runtime won't
invoke it until a `runHook("<future-name>", ctx)` call site is added.
The `HOOKS` constant tracks **wired** hook names — anything outside
that const is best-effort scaffolding for forward-compat.

---

## Tools

A tool is a default-exported object from `tools/<name>.ts`. The loader
derives the model-visible tool name from the file basename (for example,
`tools/recall.ts` becomes `recall`). Plugin tools land in the same registry
as built-in tools and are visible to the model through the standard tool
catalog.

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

Every field on a plugin tool is optional — the loader fills documented
defaults when an author omits a field:

| Field              | Default                                                           |
| ------------------ | ----------------------------------------------------------------- |
| `description`      | `""`                                                              |
| `defaultRiskLevel` | `"medium"` (prompt-then-allow on first invocation)                |
| `input_schema`     | `{ type: "object", properties: {}, additionalProperties: false }` |
| `execute`          | Returns an error result naming the tool as unimplemented          |

`export default {}` is therefore a valid (if useless) tool — broken
individual tools never block plugin load; misconfigurations surface at
call time.

---

## Marketplace — whitelisting external plugins

The catalog shown by `assistant plugins search` (and the web plugins tab) is
computed live from two sources:

1. **First-party plugins** — the directories in this folder.
2. **Whitelisted external plugins** — entries in
   [`marketplace.json`](./marketplace.json).

The manifest lets us surface plugins that live in other repos without copying
their code here. Its shape is a subset of the
[Claude Code marketplace schema](https://code.claude.com/docs/en/plugin-marketplaces):
a `name`, an optional `owner`, and a `plugins` array.

```json
{
  "name": "vellum-assistant",
  "owner": { "name": "Vellum", "url": "https://github.com/vellum-ai/vellum-assistant" },
  "plugins": [
    {
      "name": "example-plugin",
      "source": { "source": "github", "repo": "example-org/example-plugin", "ref": "e83c5163316f89bfbde7d9ab23ca2e25604af290" },
      "description": "Short summary shown in the catalog.",
      "category": "productivity",
      "homepage": "https://github.com/example-org/example-plugin",
      "license": "MIT"
    }
  ]
}
```

Per-entry fields:

- **`name`** _(required)_ — the install name. `assistant plugins install <name>`
  resolves to this entry, and the name must be a single kebab-case segment.
- **`source`** _(required)_ — only `github` sources are resolved today:
  - **`repo`** _(required)_ — `owner/repo` of the external repository.
  - **`path`** — directory within the repo holding the plugin root. Omit for
    the repository root. Must not escape the repo (`..` segments are rejected).
  - **`ref`** _(required)_ — the **full commit SHA** (40 or 64 hex chars) to
    fetch from. Tags and branches are rejected: they are mutable, so an
    upstream owner could retag/repoint them at attacker code that the assistant
    later dynamically `import()`s. A full SHA pins the install to an immutable
    revision, so the reviewed manifest fully determines what executes. To pin a
    release, resolve its tag to the underlying **commit** — peel annotated tags
    with `^{}` so you record the commit, not the tag object (which would pass
    schema validation but then fail install with a commit mismatch):
    `git ls-remote https://github.com/owner/repo 'refs/tags/vX.Y.Z^{}'`
    (or `git rev-list -n 1 vX.Y.Z` from a local clone).
- **`description`**, **`category`**, **`homepage`**, **`license`** —
  informational; surfaced in the catalog where present.

Resolution rules:

- **Curation is the whitelist.** Only repos listed here appear in the catalog;
  there is no open registry.
- **First-party wins name collisions.** If a directory in this folder and a
  marketplace entry share a name, the in-repo plugin takes precedence.
- **The manifest is supplementary.** A missing or malformed `marketplace.json`
  degrades to the first-party listing — it never blocks core plugin discovery
  or installation.

Whitelisting makes an external plugin **appear in the catalog and install by
name**. It does not guarantee the plugin's hooks/tools match this loader's
conventions — a plugin authored for another ecosystem may install yet
contribute nothing on boot until a compatibility adapter exists.

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
