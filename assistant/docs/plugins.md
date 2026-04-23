# Plugin authoring guide

Plugins let you extend the assistant by hooking middleware into named
runtime pipelines, contributing tools/routes/skills, and injecting
system-prompt content. This guide is the authoritative reference for how
plugins are structured, registered, and executed — everything the code
actually enforces.

For a worked minimal example, see
[`assistant/examples/plugins/echo/`](../examples/plugins/echo/README.md).
That plugin observes every pipeline and logs to stderr, and is the fastest
way to see the system in action.

## Table of contents

- [Anatomy of a plugin](#anatomy-of-a-plugin)
- [Where plugins live](#where-plugins-live)
- [Manifest](#manifest)
- [Registration](#registration)
- [Middleware patterns](#middleware-patterns)
- [Pipeline reference](#pipeline-reference)
- [Timeouts](#timeouts)
- [Strict-fail semantics](#strict-fail-semantics)
- [Credentials and config](#credentials-and-config)
- [Tool, route, and skill contributions](#tool-route-and-skill-contributions)
- [Cross-plugin communication](#cross-plugin-communication)
- [Hot reload](#hot-reload)
- [Troubleshooting](#troubleshooting)

---

## Anatomy of a plugin

A plugin is a directory that exports a single `register.ts` (or compiled
`register.js`) entry point. That file builds a `Plugin` object and passes
it to `registerPlugin()` as an import-time side effect. Everything else —
pipeline middleware, lifecycle hooks, model-visible capabilities — hangs
off that one `Plugin` object.

```
my-plugin/
├── package.json      # Node/Bun package metadata
├── README.md         # optional — human docs
└── register.ts       # the entry point the daemon imports
```

The `Plugin` shape is declared in
[`assistant/src/plugins/types.ts`](../src/plugins/types.ts):

```typescript
export interface Plugin {
  manifest: PluginManifest;
  init?(ctx: PluginInitContext): Promise<void>;
  onShutdown?(): Promise<void>;
  tools?: PluginToolRegistration[];
  routes?: PluginRouteRegistration[];
  skills?: PluginSkillRegistration[];
  injectors?: Injector[];
  middleware?: Partial<PipelineMiddlewareMap>;
}
```

Every field except `manifest` is optional. A plugin that only contributes
middleware doesn't need tools or routes; a plugin that only contributes a
skill can omit middleware entirely.

## Where plugins live

The assistant scans `~/.vellum/plugins/*` at startup. Any subdirectory
containing `register.js` or `register.ts` is dynamic-imported once. The
loader lives in
[`assistant/src/plugins/user-loader.ts`](../src/plugins/user-loader.ts) and
has three key properties:

- **Compiled wins.** If both `register.js` and `register.ts` are present,
  the compiled `.js` file is loaded. This matches how the compiled daemon
  binary resolves modules in production.
- **Per-plugin isolation.** If one plugin throws at import time, the error
  is logged with the plugin directory and the loader moves on. Other
  plugins still load. One broken plugin cannot brick the daemon.
- **Per-instance.** The scan runs under `vellumRoot()`, which honors the
  multi-instance `BASE_DATA_DIR` override. Each assistant instance loads
  its own plugin set.

The loader runs after first-party plugin registrations and before
`bootstrapPlugins()` invokes every plugin's `init()`.

## Manifest

The manifest is static metadata validated by the registry at registration
time. Its shape (see
[`types.ts`](../src/plugins/types.ts)):

```typescript
export interface PluginManifest {
  name: string; // kebab-case, unique
  version: string; // semver, informational
  provides?: Record<string, string>; // reserved; not consumed at runtime today
  requires: Record<string, string>; // capability → version required from the assistant
  requiresCredential?: string[]; // credential keys resolved before init()
  requiresFlag?: string[]; // feature flag keys that must all be enabled
  config?: unknown; // Zod-like parser for plugins.<name>
}
```

| Field                | Required | Purpose                                                                                                                                                                                                                                                                                                        |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | yes      | Unique plugin identifier. Duplicate names fail registration. Used as the directory under `~/.vellum/plugins-data/<name>/` and the attribution tag in logs.                                                                                                                                                     |
| `version`            | yes      | Plugin's own semver. Informational — the registry does not compare it.                                                                                                                                                                                                                                         |
| `provides`           | no       | Reserved for future cross-plugin composition and not currently consumed by the assistant. Plugin authors may set this field, but no runtime code reads it yet — it is declared here so future cross-plugin work can land without a manifest version bump. Do not rely on it for any runtime behavior today.    |
| `requires`           | yes      | Must include `pluginRuntime: "v1"` at minimum. The registry checks every entry against `ASSISTANT_API_VERSIONS` and refuses to register plugins that ask for a capability or version the assistant does not expose.                                                                                            |
| `requiresCredential` | no       | Credential keys the plugin needs. The bootstrap resolves them via the credential store before `init()` runs and hands the values to the plugin in `ctx.credentials`. A missing credential fails startup with a clear error.                                                                                    |
| `requiresFlag`       | no       | Assistant feature-flag keys that must all be ON for the plugin to activate. If any listed flag is disabled at bootstrap, the plugin is skipped entirely: `init()` is not invoked and no tools, routes, skills, or shutdown hooks are registered for it. See [Feature-flag gating](#feature-flag-gating) below. |
| `config`             | no       | A parser-like validator (Zod schema, or any object with a `.parse(input)` method). If supplied, the bootstrap validates `config.plugins.<name>` through it before passing the result into `init()`.                                                                                                            |

The exposed capability table (`ASSISTANT_API_VERSIONS`) lives in
[`registry.ts`](../src/plugins/registry.ts). It lists:

- `pluginRuntime` — the base runtime every plugin must negotiate for.
- `memoryApi`, `compactionApi`, `persistenceApi` — top-level subsystem APIs.
- One `*Api` entry per pipeline slot (e.g. `llmCallApi`, `toolExecuteApi`,
  `titleGenerateApi`, …).

Every entry is currently on `v1`. Removing or changing a version tag is a
breaking change — plugins relying on it will fail to register until they
update their `requires` map.

### Example manifest

```typescript
const manifest: PluginManifest = {
  name: "my-logger",
  version: "1.2.3",
  provides: {},
  requires: {
    pluginRuntime: "v1",
    llmCallApi: "v1",
  },
  requiresCredential: ["LOGGER_API_KEY"],
  requiresFlag: ["my-logger-enabled"],
  config: z.object({
    endpoint: z.string().url(),
    sampleRate: z.number().min(0).max(1).default(0.1),
  }),
};
```

### Feature-flag gating

`manifest.requiresFlag` lists one or more **assistant-scope** feature-flag
keys (the same keys declared in
`meta/feature-flags/feature-flag-registry.json`). The bootstrap checks each
key against `isAssistantFeatureFlagEnabled` before touching the plugin. If
**any** listed flag is disabled, the plugin is skipped entirely for the
duration of this daemon boot:

- `init()` is **not** invoked.
- `tools`, `routes`, and `skills` are **not** registered.
- No shutdown hook entry is installed, so a plugin skipped at boot has
  nothing to tear down on shutdown.

Flag state is resolved once at bootstrap time. Flipping a `requiresFlag`
key at runtime does not hot-reload the plugin — restart the daemon after
changing the flag to pick up the new state. An empty `requiresFlag` (or
the field being absent) means the plugin activates unconditionally.

The skip path emits a single `info`-level log line naming both the plugin
and the disabled flag, so operators can diagnose "why isn't my plugin
loading?" at a glance:

```
plugins-bootstrap skipping plugin my-logger: feature flag my-logger-enabled is disabled
```

**Cross-repo note:** new flag keys used here must be declared in the
assistant-scope section of
`meta/feature-flags/feature-flag-registry.json` (and provisioned in the
platform's Terraform configuration). See the root `CLAUDE.md`'s "Assistant
Feature Flags" section for the full procedure.

## Registration

A plugin's `register.ts` calls `registerPlugin()` at module load time:

```typescript
import { registerPlugin } from "<path-to-assistant>/src/plugins/registry.js";
import type { Plugin } from "<path-to-assistant>/src/plugins/types.js";

const myPlugin: Plugin = {
  manifest: {
    name: "my-plugin",
    version: "0.1.0",
    requires: { pluginRuntime: "v1" },
  },
  middleware: {
    /* ... */
  },
};

registerPlugin(myPlugin);
```

**Rules:**

- Exactly one `registerPlugin()` call per plugin. The registry rejects
  duplicate names.
- `register.ts` must not export named symbols consumed from outside. The
  loader treats the import as side-effect-only.
- Throwing inside `register.ts` is caught by the loader and logged, then
  the loader moves on. Do not rely on throws to signal "please don't load
  this plugin" — use `requiresFlag` or a guard inside `init()` instead.
- The file runs before any lifecycle hooks. Keep it fast — heavy work
  belongs in `init()`.

## Middleware patterns

Middleware is the heart of the plugin system. Every pipeline slot uses the
same onion-style signature:

```typescript
export type Middleware<A, R> = (
  args: A,
  next: (args: A) => Promise<R>,
  ctx: TurnContext,
) => Promise<R>;
```

The runner composes an array of middleware around a terminal handler. The
first middleware sees the request first and the response last; the
terminal runs at the innermost layer. See
[`assistant/src/plugins/pipeline.ts`](../src/plugins/pipeline.ts) for the
composition algorithm.

Four common patterns emerge from that signature:

### Observe-only

Record something without changing the call. Call `next(args)` unchanged,
return the result unchanged. Wrap the call in `try`/`finally` so your
observer runs on both success and failure paths.

```typescript
const observer: Middleware<ToolExecuteArgs, ToolExecuteResult> =
  async function observeToolExecute(args, next, ctx) {
    const start = performance.now();
    let outcome: "success" | "error" = "success";
    try {
      return await next(args);
    } catch (err) {
      outcome = "error";
      throw err;
    } finally {
      const ms = Math.round(performance.now() - start);
      console.error(JSON.stringify({ tool: args.name, ms, outcome }));
    }
  };
```

### Transform input

Rewrite `args` before calling downstream. Useful for request shimming
(adding headers, redacting inputs, picking a different provider).

```typescript
const addHeader: Middleware<LLMCallArgs, LLMCallResult> =
  async function addHeader(args, next, ctx) {
    const tagged = {
      ...args,
      options: {
        ...args.options,
        config: { ...args.options?.config, requestId: ctx.requestId },
      },
    };
    return next(tagged);
  };
```

### Transform output

Call `next(args)` first, then modify the result before returning.

```typescript
const redactPII: Middleware<LLMCallArgs, LLMCallResult> =
  async function redactPII(args, next, ctx) {
    const response = await next(args);
    return {
      ...response,
      content: response.content.map(redactBlock),
    };
  };
```

### Short-circuit

Do not call `next(args)` — return a synthetic result directly. The
terminal and any inner middleware are skipped. Use this to stub, cache,
or mock a pipeline.

```typescript
const cacheHit: Middleware<LLMCallArgs, LLMCallResult> =
  async function cacheHit(args, next, ctx) {
    const cached = await lookupCache(args);
    if (cached) return cached;
    return next(args);
  };
```

### Veto (throw)

Throwing from middleware aborts the pipeline. The error propagates out
through any outer middleware unchanged — there is no internal
`try`/`catch` around user middleware.

```typescript
const denyIfUnauthorized: Middleware<ToolExecuteArgs, ToolExecuteResult> =
  async function denyIfUnauthorized(args, next, ctx) {
    if (!isAuthorizedFor(args.name, ctx.trust)) {
      throw new Error(`tool ${args.name} denied by policy`);
    }
    return next(args);
  };
```

### Naming middleware

Give middleware a stable `name` (via `async function <name>(…)`). The
pipeline runner pulls `Function.name` into its `chain` log field so
operators can see the registered chain at a glance:

```
plugin.pipeline pipeline=llmCall chain=["observeLlm","addHeader","defaultLlmCall"] durationMs=1840 outcome=success
```

## Pipeline reference

Every pipeline slot and its purpose. Type details live in
[`types.ts`](../src/plugins/types.ts).

| Pipeline             | Purpose                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `turn`               | The outermost wrapper around a single assistant turn. Middleware here sees everything a turn does end-to-end. |
| `llmCall`            | Every call to `Provider.sendMessage`. Input carries `messages`, `tools`, `systemPrompt`, `options`.           |
| `toolExecute`        | Every `ToolExecutor.execute` call. Input carries `name`, `input`, and the full `ToolContext`.                 |
| `memoryRetrieval`    | PKB, NOW.md, and memory-graph retrieval for a turn. Output is a merged `MemoryResult`.                        |
| `historyRepair`      | The pre-run repair pass on the message history. Wraps `repairHistory`.                                        |
| `tokenEstimate`      | The token-count estimate used for budgeting. Wraps `estimatePromptTokensRaw`.                                 |
| `compaction`         | The conversation-compaction step. Wraps `ContextWindowManager.maybeCompact`.                                  |
| `overflowReduce`     | The reducer tier loop invoked when a turn blows the context budget.                                           |
| `persistence`        | Every message CRUD op (`add` / `update` / `delete`). Discriminated by `args.op`.                              |
| `titleGenerate`      | Conversation title generation. Fire-and-forget by default.                                                    |
| `toolResultTruncate` | The per-tool-result truncation step that fits a tool's output into the context window.                        |
| `emptyResponse`      | The decision about what to do when the model returns an empty turn (nudge / accept / error).                  |
| `toolError`          | The decision about what to do when one or more tool calls errored on a turn.                                  |
| `circuitBreaker`     | The compaction circuit breaker. Tracks consecutive-failure state, decides whether to open the circuit.        |

## Timeouts

Each pipeline has a default timeout budget in milliseconds. When the
budget is exceeded the runner throws `PluginTimeoutError` carrying the
pipeline name, the offending plugin's name (if known), and the elapsed
duration. See
[`assistant/src/plugins/pipeline.ts`](../src/plugins/pipeline.ts) for the
current values.

| Pipeline             | Timeout  | Rationale                                                                                                      |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `turn`               | none     | Turn duration is bounded by the downstream `llmCall` / `toolExecute` timeouts, not a pipeline-level timer.     |
| `llmCall`            | none     | Deferred to the provider's HTTP timeout so network hiccups surface as provider errors, not pipeline timeouts.  |
| `toolExecute`        | none     | Deferred to the per-tool timeout already enforced by `ToolExecutor`.                                           |
| `memoryRetrieval`    | 5000 ms  | Memory reads may hit Qdrant and disk; 5 s leaves slack for cold caches without blocking the turn indefinitely. |
| `historyRepair`      | 1000 ms  | CPU-bound list walk — should finish in a few ms.                                                               |
| `tokenEstimate`      | 1000 ms  | Same — CPU-bound, should return instantly.                                                                     |
| `compaction`         | 30000 ms | Summarization involves a provider call; mirrors the pipeline-level budget for LLM-backed operations.           |
| `overflowReduce`     | 30000 ms | Iterative compaction; matches the `compaction` budget since each tier step may invoke it.                      |
| `persistence`        | 10000 ms | SQLite writes, Qdrant deletes, and disk syncs. 10 s is generous for the slowest op (batched segment inserts).  |
| `titleGenerate`      | 30000 ms | Provider-backed. Fire-and-forget, but the budget exists so a stuck call doesn't leak forever.                  |
| `toolResultTruncate` | 1000 ms  | Pure string op.                                                                                                |
| `emptyResponse`      | 500 ms   | Decision logic only — must be near-instant.                                                                    |
| `toolError`          | 500 ms   | Decision logic only — must be near-instant.                                                                    |
| `circuitBreaker`     | 500 ms   | Numeric state update — must be near-instant.                                                                   |

`null` timeouts skip the timer entirely. Finite timeouts arm a
`setTimeout` that races the pipeline via `Promise.race`.

## Strict-fail semantics

**Plugin errors and timeouts fail the turn loudly. There is no silent
fallback to the default behavior.**

This is a deliberate design decision. The old inline behavior silently
absorbed many edge cases (a memory retrieval failure became an empty
memory block, a compaction error became no compaction, etc.). That made
debugging production issues miserable because failures disappeared into
logs nobody checked.

With strict-fail:

- Any error thrown from middleware propagates up to the caller. The
  pipeline runner does not catch it.
- Any `PluginTimeoutError` from a budget breach propagates identically.
- The caller (agent loop, memory subsystem, whoever) decides how to
  degrade. The pipeline itself does not paper over the failure.
- Exactly one structured log line is emitted per pipeline invocation, in
  a `finally` block, regardless of outcome. It carries `outcome`
  (`"success" | "error" | "timeout"`), `durationMs`, `chain`, plugin
  attribution, and error details when applicable.

If you're writing middleware that wants to "try, fall back to default on
failure," express that at the call site instead — wrap the pipeline
invocation in your own try/catch. Do not swallow the error inside your
middleware's `try`/`catch` and silently return a degraded result.

## Credentials and config

### Credentials

Declare required credential keys in `manifest.requiresCredential`:

```typescript
const manifest: PluginManifest = {
  name: "my-plugin",
  version: "1.0.0",
  requires: { pluginRuntime: "v1" },
  requiresCredential: ["MY_PLUGIN_API_KEY"],
};
```

During bootstrap, the assistant resolves each key through the credential
store (via `getSecureKeyAsync`). In Docker mode that call goes through
the CES HTTP API; in local mode it hits the encrypted file store / CES
RPC backend. The resolved values are handed to your `init()`:

```typescript
async init(ctx: PluginInitContext) {
  const apiKey = ctx.credentials["MY_PLUGIN_API_KEY"];
  // use it
}
```

**Rules:**

- Never import the credential store directly. Always go through the
  manifest.
- Missing credentials fail startup with a clear error naming the plugin
  and the key. There is no silent fallback.
- Credentials are resolved once at bootstrap. Long-running plugins that
  need rotation must re-resolve through their own mechanism.

### Config

Declare a parser-like validator in `manifest.config`:

```typescript
const configSchema = z.object({
  endpoint: z.string().url(),
  sampleRate: z.number().min(0).max(1).default(0.1),
});

const manifest: PluginManifest = {
  name: "my-plugin",
  version: "1.0.0",
  requires: { pluginRuntime: "v1" },
  config: configSchema,
};
```

The bootstrap reads `config.plugins.<name>` from the assistant's config
and calls `manifest.config.parse(raw)`. The parsed result is handed to
your `init()`:

```typescript
async init(ctx: PluginInitContext) {
  const cfg = ctx.config as z.infer<typeof configSchema>;
  // use cfg
}
```

If you don't supply a validator, the raw config is passed through
untouched as `unknown` and your plugin must narrow it itself.

### Other init context fields

The full `PluginInitContext`:

```typescript
export interface PluginInitContext {
  config: unknown; // parsed config (or raw if no validator)
  credentials: Record<string, string>; // resolved credentials from requiresCredential
  logger: unknown; // pino child logger, tagged { plugin: <name> }
  pluginStorageDir: string; // ~/.vellum/plugins-data/<name>/ (created by bootstrap)
  assistantVersion: string; // assistant semver
  apiVersions: Record<string, string[]>; // ASSISTANT_API_VERSIONS, for runtime checks
}
```

`pluginStorageDir` is a per-plugin writable directory. Use it for
persistent state — cache files, counters, anything that must survive a
daemon restart. The bootstrap creates it on demand.

## Tool, route, and skill contributions

Plugins can contribute model-visible capabilities alongside their
middleware. Each is optional.

### Tools (`plugin.tools`)

An array of `Tool` objects. The bootstrap registers them with the global
tool registry after `init()` succeeds, stamping `origin: "skill"` and
`ownerSkillId: <plugin.name>` so they participate in skill-scoped
ref-counting.

```typescript
const myPlugin: Plugin = {
  manifest: {
    /* ... */
  },
  tools: [
    {
      name: "my_tool",
      description: "Does the thing.",
      category: "plugin",
      defaultRiskLevel: "low",
      getDefinition: () => ({
        name: "my_tool",
        description: "Does the thing.",
        input_schema: { type: "object", properties: {}, required: [] },
      }),
      execute: async (input, ctx) => ({ content: "result", isError: false }),
    },
  ],
};
```

Tools are unregistered automatically on shutdown. See
[`assistant/src/tools/types.ts`](../src/tools/types.ts) for the full
`Tool` interface including optional fields like `executionMode` and
`executionTarget`.

### Routes (`plugin.routes`)

An array of `SkillRoute` objects — the same shape the skill-route
registry consumes. Registered via `registerSkillRoute` after `init()`
succeeds, unregistered on shutdown.

```typescript
const myPlugin: Plugin = {
  manifest: {
    /* ... */
  },
  routes: [
    {
      pattern: /^\/_plugin\/my-plugin\/status$/,
      methods: ["GET"],
      handler: async (req, match) => new Response("ok"),
    },
  ],
};
```

### Skills (`plugin.skills`)

An array of `PluginSkillRegistration` objects. Each becomes a discoverable
skill under `source: "plugin"` in the model's `skill_load` /
`skill_execute` flow.

```typescript
const myPlugin: Plugin = {
  manifest: {
    /* ... */
  },
  skills: [
    {
      id: "my-plugin/do-thing",
      name: "do-thing",
      description: "Does the thing via plugin-contributed skill.",
      body: "# SKILL.md body returned when loaded\n...",
    },
  ],
};
```

See
[`plugin-skill-contributions.ts`](../src/plugins/plugin-skill-contributions.ts)
for the in-memory registry details and ref-counted lifecycle.

### Injectors (`plugin.injectors`)

An array of `Injector` objects that emit system-prompt-time content.
Each has a stable `name`, an ascending `order` used to position it in the
injection chain, and a `produce(ctx)` method that returns an
`InjectionBlock` or `null`.

The default injectors use `order` 10 through 70 with gaps of 10, so
plugin-contributed injectors can slot at `25`, `35`, etc. without
renumbering.

```typescript
const myPlugin: Plugin = {
  manifest: {
    /* ... */
  },
  injectors: [
    {
      name: "my-plugin/status",
      order: 25,
      async produce(ctx) {
        return {
          id: "my-plugin/status",
          text: `<my_plugin_status>ok</my_plugin_status>`,
        };
      },
    },
  ],
};
```

## Cross-plugin communication

Plugins should not call each other directly. There is no cross-plugin
import API — a plugin's export surface is intentionally limited to the
`Plugin` object it registers.

For cross-cutting concerns (broadcasting events, reacting to
system-level changes), use the `assistantEventHub` pub/sub in
[`runtime/assistant-event-hub.ts`](../src/runtime/assistant-event-hub.ts).
The hub is the canonical place to publish events from inside the daemon
process and to subscribe from anywhere that has access to the daemon's
module graph.

Do not add new HTTP endpoints to implement plugin-to-plugin messaging
inside a single daemon process.

`manifest.provides` is reserved as the hook for a future cross-plugin
capability-negotiation protocol but is **not currently consumed by any
runtime code**. Declaring `provides` today has no behavioral effect —
plugins must not depend on it for capability discovery or any other
runtime purpose. The field is intentionally retained on the manifest so
that adding real consumers later does not require bumping
`pluginRuntime` or any other capability version.

## Hot reload

**Not supported in v1.** Registering a plugin takes effect at daemon
startup only. To pick up a new or modified plugin:

```bash
vellum restart
```

The registry's internal state is not mutable at runtime. `init()` and
`onShutdown()` hooks are fired exactly once per daemon boot.

If you need hot reload for development, symlink your plugin directory
into `~/.vellum/plugins/` so edits propagate, and automate the restart
loop externally.

## Troubleshooting

### "plugin X must declare requires.pluginRuntime"

The manifest's `requires` map is missing the `pluginRuntime` entry. Every
plugin must negotiate against the base runtime:

```typescript
requires: { pluginRuntime: "v1" },
```

### "plugin X requires Y@vN, assistant exposes (none|v...)"

The `requires` map names a capability the assistant does not expose, or
asks for a version not listed under that capability. See
`ASSISTANT_API_VERSIONS` in
[`registry.ts`](../src/plugins/registry.ts) for the currently-exposed
list. Either downgrade the required version or update your plugin to
match.

### "plugin X is already registered"

Two plugins tried to register under the same `manifest.name`. Names must
be globally unique. Rename one, or if this is a dev-reload issue,
restart the daemon.

### "plugin X requires credential Y but the credential store returned no value"

The credential named in `requiresCredential` is not set. Run:

```bash
vellum credentials set Y
```

…and restart the daemon.

### "plugin X config validation failed: …"

The config block under `config.plugins.<name>` failed the manifest's
parser. Check your config against the plugin's schema — the error
message carries the validator's diagnostic.

### `PluginTimeoutError: Plugin pipeline '<name>' timed out after N ms`

A plugin's middleware exceeded the pipeline's budget. The offending
plugin is named in `ctx.pluginName` when available. Tighten the
middleware (it's probably blocking on I/O it shouldn't) or, if the
work is genuinely heavy, move it out of the critical path into a
background job that publishes results through `assistantEventHub`.

### Reading pipeline log records

Every pipeline invocation emits one structured line tagged
`event=plugin.pipeline`. The fields:

| Field                                      | Meaning                                                               |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `pipeline`                                 | Pipeline name (`llmCall`, `toolExecute`, …).                          |
| `chain`                                    | Ordered list of middleware function names, outermost first.           |
| `durationMs`                               | Total time spent in the composed chain.                               |
| `outcome`                                  | `"success"`, `"error"`, or `"timeout"`.                               |
| `pluginName`                               | The specific plugin's name when the runner could attribute the frame. |
| `timeoutMs`                                | The configured budget (only when one was set).                        |
| `errorName`, `errorMessage`, `errorStack`  | Present on failure outcomes.                                          |
| `requestId`, `conversationId`, `turnIndex` | Per-turn context for correlating with the rest of the daemon's logs.  |

Pipe the daemon's stderr through `jq` to filter and inspect:

```bash
tail -f ~/.vellum/daemon.log | jq 'select(.event == "plugin.pipeline")'
```

To isolate slow pipelines:

```bash
tail -f ~/.vellum/daemon.log \
  | jq 'select(.event == "plugin.pipeline" and .durationMs > 1000)'
```

To isolate errors and timeouts:

```bash
tail -f ~/.vellum/daemon.log \
  | jq 'select(.event == "plugin.pipeline" and .outcome != "success")'
```

### Plugin not loading at all

- Confirm the directory is under `~/.vellum/plugins/` (or the per-instance
  equivalent under `$BASE_DATA_DIR/.vellum/plugins/`).
- Confirm it has a `register.ts` or `register.js` at the top level.
- Check the daemon's stderr for a line like
  `loaded user plugin (side-effect import completed)` or
  `Failed to load user plugin <dir>: <err>`. Import-time throws are
  logged but do not crash the daemon — the plugin is silently skipped
  otherwise.
- Verify `register.ts` calls `registerPlugin()` exactly once at module
  level. If the call is inside an unrelated conditional or wrapped in
  an async function that is never awaited, the registry won't see it.
