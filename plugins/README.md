# Plugins

Plugins extend the assistant's default capabilities using hooks, tools,
skills, and more.

If you're authoring a plugin against the current convention, this file is
your map. Read [`vellum-ai/simple-memory`](https://github.com/vellum-ai/simple-memory)
alongside, it's the canonical reference implementation and exercises every
wired surface.

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

| Surface             | Directory                | Discovery                                                       |
| ------------------- | ------------------------ | --------------------------------------------------------------- |
| Lifecycle hooks     | `hooks/<name>.ts`        | filename → `plugin.hooks[<name>]`                               |
| Model-visible tools | `tools/<name>.ts`        | each file's default export → `plugin.tools[]`                   |
| Skills              | `skills/<id>/SKILL.md`   | picked up on disk by the skill catalog loader                   |
| Skill-scoped tools  | `skills/<id>/TOOLS.json` | registered only while the skill is active (see [Tools](#tools)) |

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
│   ├── post-model-call.ts     # Per-call reply transform + continue decision
│   ├── stop.ts                # Per-run terminal teardown
│   ├── post-compact.ts        # Re-inject context after mid-turn compaction
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
type HookFunction<TCtx> = (ctx: TCtx) => Promise<Partial<TCtx> | void>;
```

The return shape means a hook can either **mutate `ctx` in place and
return `void`** or **return a partial ctx** — the runtime merges the
returned fields onto the threaded context (keys you return overwrite,
everything else is preserved), then forwards the merged ctx to the next
plugin, and ultimately to the assistant's agent loop. Returning a partial
lets a hook edit just the subset of fields it cares about. Because an
omitted key means "keep the existing value", context fields are always
required and use `| null` (never `| undefined`) for empty values, so a
missing key is never confused with an explicit clear.

### `init`

Fires once the first time the plugin is registered, whether that is on
assistant boot or on installation, after all other contributions by the
plugin.

```ts
// hooks/init.ts
import type { InitContext } from "@vellumai/plugin-api";

export default async function init(ctx: InitContext): Promise<void> {
  // ctx.config            — your validated config (typed `unknown` for now)
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
import type { ShutdownContext } from "@vellumai/plugin-api";

export default async function shutdown(
  ctx: ShutdownContext,
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
  // ctx.modelProfile         — inference profile (key in `llm.profiles`) this call
  //                            routes to; set it to route to a different profile
  // ctx.deferAssistantOutput — set true to suppress this turn's live text stream
  //                            (a `post-model-call` hook then emits the text)
  // ctx.logger               — turn-scoped; tag log fields with { plugin: <name> }
}
```

Setting `ctx.modelProfile` to a profile key (one of the entries in the
workspace's `llm.profiles`) routes this single call to that profile — the lever a
**model router** uses to pick a model per message. It is seeded with the call's
already-resolved override profile; clear it to `null` to send no override. For
the user-facing `mainAgent` call the named profile sits at the top of resolution
precedence (above the workspace's active profile), so the hook's choice wins; a
key that names no profile falls through unchanged.

Context-window sizing and overflow recovery for a call are computed from the
profile resolved before the hook runs, so routing a near-budget conversation to
a profile with a smaller context window relies on the loop's overflow recovery
(compact and retry) rather than proactive compaction.

```ts
// hooks/pre-model-call.ts — route the user-facing reply by classified intent
import type { PreModelCallContext } from "@vellumai/plugin-api";

export default function preModelCall(ctx: PreModelCallContext): void {
  // Only route the user-facing reply; leave background/utility calls untouched.
  if (ctx.callSite !== "mainAgent") return;
  ctx.modelProfile = classify(ctx); // e.g. "cost-optimized" | "balanced" | "quality-optimized"
}
```

Multiple plugins' hooks chain in registration order — each sees the previous
hook's edits. Throwing is contained by the loop: the provider call proceeds with
the original request.

**Discovering routable profiles.** Profile keys vary per workspace, so a router
shouldn't hard-code them. The runtime handle `getModelProfiles()` returns the
profiles this workspace defines, in the order the `/model` picker shows them —
each entry is `{ key, label, description, isActive, isDisabled, isMix }`. Assign
a `key` to `ctx.modelProfile` to route a call there. Disabled profiles are
included and flagged via `isDisabled`; weighted "mix" profiles are included and
flagged via `isMix` (a mix is a valid target — routing to it A/B-splits the call
across its constituents per conversation). It reads live config, so call it
whenever you need the current set — at `init` to build a map once, or per call.

```ts
// hooks/init.ts — build and validate the router's category → profile map
import { getModelProfiles, type InitContext } from "@vellumai/plugin-api";

const CATEGORY_PROFILE: Record<string, string> = {
  chat: "cost-optimized",
  research: "balanced",
  deep: "quality-optimized",
};

export default function init(ctx: InitContext): void {
  const routable = new Set(
    getModelProfiles()
      .filter((p) => !p.isDisabled)
      .map((p) => p.key),
  );
  for (const [category, key] of Object.entries(CATEGORY_PROFILE)) {
    if (!routable.has(key)) {
      ctx.logger.warn({ category, key }, "configured profile missing or disabled");
    }
  }
}
```

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

### `post-model-call`

Fires at **every model-call outcome** — the seam where the loop reacts to what
the provider returned, and the hook that owns the **continue/retry decision**.
Two outcomes reach it:

- **Finalized reply.** The provider returned a message. `ctx.error` is absent,
  `ctx.content` holds the reply's blocks (**mutable** — the loop adopts the
  hook's result as the persisted and streamed message), and `ctx.stopReason`
  carries the provider stop reason. Fires once per model call, including
  tool-bearing turns (a reply can carry both text and `tool_use`), so transform
  only the blocks you own and leave others — notably `tool_use` — intact.
- **Provider rejection.** The call threw before any reply existed. `ctx.error`
  holds the rejection, `ctx.content` is empty, and `ctx.stopReason` is `null`. A
  hook that recognizes the rejection can repair `ctx.messages` and request a
  retry; hooks that only act on a real reply must guard on `ctx.error` and
  return early.

Runs for every model call regardless of call site, so **self-gate** on
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
  // ctx.content        — finalized message content (mutable); empty on a
  //                      rejection. Transform text blocks, leave tool_use intact
  // ctx.messages       — full conversation history; when continuing, leave this
  //                      as the history the next iteration should send
  // ctx.error          — the provider rejection, on a rejection outcome; absent
  //                      on a finalized reply
  // ctx.stopReason     — provider stop reason, when reported
  // ctx.decision       — seeded "stop"; set "continue" to re-query the model
  // ctx.logger         — turn-scoped; tag log fields with { plugin: <name> }
}
```

**Continuing the loop branches from the model-call outcome.** The hook owns the
retry decision by setting `ctx.decision`. The default is `"stop"` (accept the
outcome: keep the finalized reply, or surface the rejection). Setting it to
`"continue"` re-queries the model — leave `ctx.messages` as the history the next
iteration should send: a finalized-reply hook appends a follow-up turn (e.g. a
nudge `user` message), a rejection-recovery hook replaces the array with a
repaired one. The decision is honored only at **actionable outcomes** — a
no-tool reply or a provider rejection — and is ignored on tool-bearing turns
(the loop already runs the tools). The loop does **not** gate the decision on
call site, so a hook that should only retry the user-facing turn must self-gate
on `ctx.callSite` (above) to avoid re-querying background, subagent, or
compaction calls.

The loop owns the retry budget: a hook may request `continue` every iteration,
but the loop stops once its retry cap is spent, so a continuing hook cannot loop
forever. A `pre-model-call` hook can set `deferAssistantOutput` to suppress the
live stream; the loop then emits this hook's finalized text once.

Multiple plugins' hooks chain in registration order — each sees the previous
hook's `content`, `decision`, and `messages` mutations. Throwing is contained by
the loop: the original content is kept and the outcome is treated as `"stop"`.
The default recovery plugins live here, and because defaults register first they
run ahead of user hooks: `empty-response` re-queries with a nudge when a no-tool
reply comes back empty or as a refusal; `history-repair` repairs the history and
retries on a message-ordering rejection; `image-recovery` downscales and retries
on an image-too-large rejection.

### `stop`

The loop's **definitive terminal hook**. Fires exactly once per `run()`, after
the loop has committed to ending and will not run another iteration this run.
Unlike `post-model-call`, `stop` **cannot continue the loop** — by the time it
runs the turn's outcome is settled. That guarantee makes it the home for
**teardown**: a hook can release per-turn resources or clear per-turn state
knowing nothing will re-enter the loop this run.

It fires on **every terminal exit** — a no-tool reply, a max-tokens stop, a
yield-to-user, an exhausted context-overflow recovery, a user abort, or an
unhandled error — and on a `checkpoint_handoff` (which ends the run for teardown
purposes even though the orchestrator resumes the conversation in a fresh run).
`ctx.exitReason` reports which one, so a hook that should act only on a
particular ending guards on it.

```ts
// hooks/stop.ts
import type { StopContext } from "@vellumai/plugin-api";

export default async function stop(ctx: StopContext): Promise<void> {
  // ctx.conversationId — ID of the conversation the run belongs to
  // ctx.messages       — full conversation history at the terminal stop
  //                      (read-only; mutating it has no effect)
  // ctx.exitReason     — which terminal state the turn reached (e.g.
  //                      "no_tool_calls", "max_tokens_reached", "error",
  //                      "checkpoint_handoff")
  // ctx.error          — the rejection that ended the turn, when it ended on
  //                      one; absent on a clean stop
  // ctx.logger         — turn-scoped; tag log fields with { plugin: <name> }
}
```

`stop` neither transforms the reply nor decides the outcome — the retry decision
lives in `post-model-call`. Use it purely to observe how the turn ended and tear
down. Multiple plugins' hooks chain in registration order over the same context;
a throwing teardown hook is logged with attribution and does not suppress the
terminal exit. The default `title-generate` plugin contributes a hook here that
(re)titles the conversation once a user-facing turn truly ends.

### `post-compact`

Fires after the loop **compacts a conversation mid-turn** — once the running
history has been summarized down to fit the context window, and before the turn
resumes with the next provider call. Compaction strips the turn's runtime
injections (scratchpad, retrieved memory, workspace context, transcript
snapshots) along with the raw messages it summarizes; this hook's job is to
**re-apply** whatever injected context must survive onto the freshly compacted
history.

```ts
// hooks/post-compact.ts
import type { PostCompactContext } from "@vellumai/plugin-api";

export default async function postCompact(
  ctx: PostCompactContext,
): Promise<void> {
  // ctx.history          — compacted message history to re-inject onto
  //                        (mutable; the loop resumes the turn from the
  //                        settled value)
  // ctx.requestId        — stable ID of the request driving this turn; forward
  //                        onto the injector so re-applied blocks are attributed
  // ctx.conversationId   — conversation the turn being compacted is scoped to
  // ctx.isNonInteractive — true when no human is present (scheduled, background,
  //                        or headless run)
  // ctx.modelProfileKey  — effective inference-profile identity for the model
  //                        the compacted turn keeps using
  // ctx.injectionMode    — "full" (restore complete runtime context) or
  //                        "minimal" (reduced volume the overflow-recovery
  //                        downgrade selects); defaults to "full"
}
```

Re-inject by mutating `ctx.history` in place (or returning a new context with a
replacement `history`); the loop reads the settled `history` back off the context
and resumes the turn from it. Multiple plugins' hooks chain in registration order
— each sees the previous plugin's edits. The default memory-retrieval plugin
contributes a hook here that re-injects its memory blocks and re-tracks the
memory graph; user hooks can re-apply their own injected context the same way.

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

**Always-on cost — prefer skill-scoped tools.** A `tools/<name>.ts` tool sits
on every conversation's tool catalog on every turn, whether or not the plugin
is relevant. When a tool only matters while one of the plugin's skills is
active, declare it in that skill's `TOOLS.json` instead: it registers when the
skill loads, unregisters when the skill deactivates, and is invoked through
`skill_execute` (its schema is rendered into the `skill_load` output). Skill
tools in plugin skills must declare `execution_target: "sandbox"` — host
execution is reserved for first-party bundled skills — and a tool name may be
owned by only one skill, so share a single carrier skill via the parents'
`includes` rather than duplicating the entry. See the `plugin-builder` skill's
`references/skills.md` for the manifest shape; `admin-copilot` is the
reference implementation.

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
computed live from the whitelisted external plugins listed in
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
- **A marketplace entry owns its name.** A directory in this folder that shares
  a name with an entry is that plugin's [postinstall adapter
  stub](#postinstall-adapters) (below), overlaid onto the external clone — not
  a standalone plugin. Directories here exist only as adapter stubs; the
  catalog is the marketplace manifest alone.
- **The manifest is the catalog.** `marketplace.json` is the sole source of
  installable plugins. A missing or malformed manifest yields an empty catalog
  rather than falling back to an in-repo listing.

Whitelisting makes an external plugin **appear in the catalog and install by
name**. It does not by itself guarantee the plugin's hooks/tools match this
loader's conventions — a plugin authored for another ecosystem may install yet
contribute nothing on boot. A **postinstall adapter** bridges that gap.

### Installing a plugin not in the marketplace (untrusted)

While a plugin is still under development — before it is whitelisted here —
install it directly from its GitHub repo by passing a URL (anything containing a
slash) instead of a marketplace name:

```bash
assistant plugins install https://github.com/owner/repo
assistant plugins install https://github.com/owner/repo/tree/my-branch/sub/path
assistant plugins install owner/repo --name my-plugin
```

The ref comes from the URL's `/tree/<ref>/` segment, or defaults to the
repository's default branch. The install directory name is derived from the repo
(or sub-path leaf) and can be overridden with `--name`.

A direct install **bypasses marketplace curation entirely**: the tree is
materialized verbatim (no [postinstall adapter](#postinstall-adapters) is
overlaid), and the source is **untrusted** — it has not been reviewed and its
hooks/tools run inside the assistant with full access. The CLI prints a yellow
warning naming the source, so the choice to trust it is explicit. Unlike
marketplace installs — which pin an immutable, reviewed commit SHA — a branch or
`HEAD` ref is mutable, so a direct install is a development convenience, not a
reproducible pin. The marketplace-only flags (`--ref`, `--pin`,
`--allow-unreviewed`) do not apply.

### Postinstall adapters

External ecosystem plugins are often shaped for a different host (e.g. a Claude
Code plugin keyed on a `.claude-plugin/plugin.json`), so installed verbatim
they fail this loader's contract — a name that doesn't match the directory, no
`@vellumai/plugin-api` peer dependency, no `hooks/`/`tools/`. A postinstall
adapter is a small, curated transform we commit *here* to translate such a
clone into Vellum's shape.

To adapt an external plugin, add a directory next to this README named for the
marketplace entry. It supplies a `package.json` whose only job is to name the
`postinstall` adapter command, the adapter script, and any templates the
adapter renders:

```
plugins/<name>/
├── package.json        # { "name": "<name>", "scripts": { "postinstall": "bun ./postinstall.ts" } }
├── postinstall.ts      # the adapter — runs with the staged clone as its cwd
└── templates/          # hook/source templates the adapter interpolates
```

Install flow for an entry that has a stub:

1. The marketplace entry's pinned repo is shallow-cloned at its commit.
2. This stub's files are **overlaid** onto the clone so the installer can find
   and run its `scripts.postinstall`.
3. The stub's `scripts.postinstall` is run against the staged tree to shape it
   into a valid Vellum plugin (e.g. synthesize `hooks/<name>.ts`). A failure
   aborts and rolls back the install.
4. The installer rebuilds the plugin's `package.json` from the **upstream**
   manifest captured before the overlay — preserving its `version`,
   `description`, `license`, and every other field — mutating only the two the
   loader requires: `name` (set to the install directory) and the
   `@vellumai/plugin-api` peer dependency. The spent `postinstall` script is
   dropped. An adapter therefore never needs to touch `package.json`.

See [`caveman/`](./caveman/) for a worked example: it reads the terse-mode
ruleset from the upstream `skills/caveman/SKILL.md` and renders
`templates/pre-model-call.ts.tmpl` into a `hooks/pre-model-call.ts` that injects
that ruleset on the user-facing model call.

Trust boundary: only `scripts.postinstall` from a **curated stub in this repo**
ever runs — it is reviewed Vellum code, version-pinned to the marketplace ref.
The upstream repo's own lifecycle scripts are never executed. The adapter is
restricted to a single `bun <script>` invocation pointing at a `.ts`/`.js` file
inside the stub, run under a stripped environment and a timeout.

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
