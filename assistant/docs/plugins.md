# Plugins

> **Note:** This guide documents the **legacy** plugin architecture — the
> in-tree `register.ts` registration system. We are converging on
> the schema at
> [`experimental/plugins/README.md`](../../experimental/plugins/README.md)
> (file-based discovery, a `package.json` manifest, the
> `@vellumai/plugin-api` public contract). The plan is to reshape this guide
> section by section until it matches that one; wherever the two still
> differ is the next piece of consolidation work. New plugins should target
> the modern schema.

Plugins extend the assistant's default capabilities using hooks, tools,
skills, and more.

If you're authoring a plugin against the current convention, this file is
your map. Read [`examples/plugins/echo/`](../examples/plugins/echo/README.md)
alongside, it's the canonical reference implementation and exercises every
wired surface.

## Table of contents

- [TL;DR](#tldr)
- [What a plugin can contribute today](#what-a-plugin-can-contribute-today)
- [Anatomy of a plugin](#anatomy-of-a-plugin)
- [Where plugins live](#where-plugins-live)
- [Manifest](#manifest)
- [Registration](#registration)
- [Hooks](#hooks)
- [Strict-fail semantics](#strict-fail-semantics)
- [Credentials and config](#credentials-and-config)
- [Tool, route, and skill contributions](#tool-route-and-skill-contributions)
- [Cross-plugin communication](#cross-plugin-communication)
- [Hot reload](#hot-reload)
- [Troubleshooting](#troubleshooting)

---

## TL;DR

1. Create a directory `<workspaceDir>/plugins/my-plugin/`.
2. Drop a `package.json` with a `name` and a `peerDependencies["@vellumai/plugin-api"]` semver range.
3. Add `hooks/<name>.ts` files (default export = hook function).
4. Add `tools/<name>.ts` files (default export = tool definition).
5. Restart the assistant — the loader scans `<workspaceDir>/plugins/*` and
   registers the plugin on startup.

## What a plugin can contribute today

| Surface                    | Where           | Discovery                                  |
| -------------------------- | --------------- | ------------------------------------------ |
| Model-visible tools        | `plugin.tools`  | each `PluginToolRegistration`              |
| HTTP routes                | `plugin.routes` | each `PluginRouteRegistration`             |
| Skills                     | `plugin.skills` | each `PluginSkillRegistration`             |
| Lifecycle & per-turn hooks | `plugin.hooks`  | keyed by hook name (`init`, `shutdown`, …) |

The modern schema wires only **hooks** and **tools**; routes and skills
above are the surfaces that still have no modern equivalent.

---

## Anatomy of a plugin

A plugin is a directory that exports a single `register.ts` (or compiled
`register.js`) entry point. That file builds a `Plugin` object and passes
it to `registerPlugin()` as an import-time side effect. Everything else —
lifecycle hooks, model-visible capabilities — hangs off that one `Plugin`
object.

```
my-plugin/
├── package.json      # Node/Bun package metadata
├── README.md         # optional — human docs
└── register.ts       # the entry point the assistant imports
```

The `Plugin` shape is declared in
[`assistant/src/plugins/types.ts`](../src/plugins/types.ts):

```typescript
export interface Plugin {
  manifest: PluginManifest;
  hooks?: PluginHooks;
  tools?: Tool[];
  routes?: PluginRouteRegistration[];
  skills?: PluginSkillRegistration[];
}
```

Every field except `manifest` is optional. A plugin that only contributes
a hook doesn't need tools or routes; a plugin that only contributes a
skill can omit everything else. Lifecycle and per-turn behavior live under
`hooks` (see [Hooks](#hooks)).

## Where plugins live

The assistant scans `<workspaceDir>/plugins/*` at startup. Any subdirectory
containing `register.js` or `register.ts` is dynamic-imported once. The
loader lives in
[`assistant/src/plugins/user-loader.ts`](../src/plugins/user-loader.ts) and
has three key properties:

- **Compiled wins.** If both `register.js` and `register.ts` are present,
  the compiled `.js` file is loaded. This matches how the compiled
  assistant binary resolves modules in production.
- **Per-plugin isolation.** If one plugin throws at import time, the error
  is logged with the plugin directory and the loader moves on. Other
  plugins still load. One broken plugin cannot brick the assistant.
- **Per-instance.** The scan runs under `vellumRoot()`. Each assistant
  instance loads its own plugin set.

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
  requiresCredential?: string[]; // credential keys resolved before init()
  requiresFlag?: string[]; // feature flag keys that must all be enabled
  config?: unknown; // Zod-like parser for plugins.<name>
}
```

| Field                | Required | Purpose                                                                                                                                                                                                                                                                                                        |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | yes      | Unique plugin identifier. Duplicate names fail registration. Used as the directory under `<workspaceDir>/plugins-data/<name>/` and the attribution tag in logs.                                                                                                                                                |
| `version`            | yes      | Plugin's own semver. Informational — the registry does not compare it.                                                                                                                                                                                                                                         |
| `requiresCredential` | no       | Credential keys the plugin needs. The bootstrap resolves them via the credential store before `init()` runs and hands the values to the plugin in `ctx.credentials`. A missing credential fails startup with a clear error.                                                                                    |
| `requiresFlag`       | no       | Assistant feature-flag keys that must all be ON for the plugin to activate. If any listed flag is disabled at bootstrap, the plugin is skipped entirely: `init()` is not invoked and no tools, routes, skills, or shutdown hooks are registered for it. See [Feature-flag gating](#feature-flag-gating) below. |
| `config`             | no       | A parser-like validator (Zod schema, or any object with a `.parse(input)` method). If supplied, the bootstrap validates `config.plugins.<name>` through it before passing the result into `init()`.                                                                                                            |

### Host-compat: `peerDependencies["@vellumai/plugin-api"]`

Plugins declare which assistant versions they support via standard
`peerDependencies` in their `package.json`:

```json
{
  "name": "@me/my-logger",
  "version": "1.2.3",
  "peerDependencies": {
    "@vellumai/plugin-api": "^0.8.0"
  }
}
```

At load time, the external-plugin loader resolves the assistant's running
version and runs `semver.satisfies(assistantVersion, range)` against the
declared range. The contract is currently soft while the plugin-installation
flow is in flux:

- **Range satisfied** — plugin loads.
- **Range not satisfied** — loader logs an error (`log.error`) and loads
  the plugin anyway.
- **Range unparseable** — loader logs an error and loads the plugin anyway.
- **`@vellumai/plugin-api` peerDep absent** — loader logs a warning and
  loads the plugin without a host-compat claim.

Once the install flow settles, the two error-logging branches above will
harden into hard rejections (with per-plugin isolation catching the
throw so one bad plugin can't brick the rest of the registry).

In-tree default plugins do not declare a peerDep — they ship with the
assistant binary and are version-locked by construction.

### Example manifest

```typescript
const manifest: PluginManifest = {
  name: "my-logger",
  version: "1.2.3",
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
duration of this assistant boot:

- `init()` is **not** invoked.
- `tools`, `routes`, and `skills` are **not** registered.
- No shutdown hook entry is installed, so a plugin skipped at boot has
  nothing to tear down on shutdown.

Flag state is resolved once at bootstrap time. Flipping a `requiresFlag`
key at runtime does not hot-reload the plugin — restart the assistant
after changing the flag to pick up the new state. An empty `requiresFlag` (or
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

A plugin's `register.ts` calls `registerPlugin()` at module load time. The
function is exposed via the `globalThis.__vellumPluginRuntime` bridge so the
plugin file does not need to import from the daemon's source tree:

```typescript
import type { Plugin } from "<path-to-assistant>/src/plugins/types.js";

interface VellumPluginRuntime {
  readonly version: 1;
  readonly registerPlugin: (plugin: Plugin) => void;
  readonly assistantEventHub: import("<path-to-assistant>/src/runtime/assistant-event-hub.js").AssistantEventHub;
  readonly getSecureKeyAsync: (account: string) => Promise<string | undefined>;
}

const runtime = (globalThis as { __vellumPluginRuntime?: VellumPluginRuntime })
  .__vellumPluginRuntime;
if (!runtime || runtime.version !== 1) {
  throw new Error(
    "vellum plugin runtime not available — install a recent assistant build",
  );
}
const { registerPlugin } = runtime;

const myPlugin: Plugin = {
  manifest: {
    name: "my-plugin",
    version: "0.1.0",
  },
  hooks: {
    /* ... */
  },
};

registerPlugin(myPlugin);
```

**Why the bridge?** When the daemon is a `bun --compile` binary, its modules
are bundled into the executable. Plugins that import the daemon's modules by
absolute path (`/abs/path/to/assistant/src/plugins/registry.js`) reload fresh
disk copies into a separate module graph, and any `registerPlugin()` call in
the plugin lands in a registry the daemon never reads. The
`globalThis.__vellumPluginRuntime` handle is the same instance the daemon's
bundled code holds onto, so plugin registrations always reach the right
place — whether the daemon was built with `bun --compile` or is running from
source.

Type-only imports (`import type { Plugin } from "..."`) remain free to use
absolute paths to the assistant source — the TypeScript compiler erases them
and they have no module-identity effect at runtime.

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
- The bridge is installed by the daemon before `loadUserPlugins()` runs, so
  the global is always present when a plugin's module body executes.

## Hooks

Hooks are the **modern** lifecycle surface: a plugin contributes one
function per phase under `plugin.hooks`, keyed by hook name. The wired
hook names live in [`HOOKS`](../src/plugin-api/constants.ts); the context
shapes and a full authoring walkthrough live in the
[experimental plugin guide](../../experimental/plugins/README.md#hooks).

Every hook implements `PluginHookFn` — it receives a context and either
mutates it in place (returning `void`) or returns a replacement. Hooks
from multiple plugins chain in registration order, and defaults register
first.

| Hook                 | Fires                                                             | Context                   |
| -------------------- | ----------------------------------------------------------------- | ------------------------- |
| `init`               | Once when the plugin is registered.                               | `PluginInitContext`       |
| `shutdown`           | Once when the plugin is torn down.                                | `PluginShutdownContext`   |
| `user-prompt-submit` | Once per user turn, before the agent loop receives the messages.  | `UserPromptSubmitContext` |
| `post-tool-use`      | Once per tool result, before it joins the provider-bound history. | `PostToolUseContext`      |
| `stop`               | Once per run when the model yields a turn with no tool calls.     | `StopContext`             |

## Strict-fail semantics

**Plugin errors fail the turn loudly. There is no silent fallback to the
default behavior.**

This is a deliberate design decision. The old inline behavior silently
absorbed many edge cases (a memory retrieval failure became an empty
memory block, a compaction error became no compaction, etc.). That made
debugging production issues miserable because failures disappeared into
logs nobody checked.

With strict-fail:

- Any error thrown from a hook propagates up to the caller. The hook
  runner does not catch it.
- The caller (agent loop, memory subsystem, whoever) decides how to
  degrade. The runner itself does not paper over the failure.

If you're writing a hook that wants to "try, fall back to default on
failure," express that at the call site instead — wrap the hook
invocation in your own try/catch. Do not swallow the error inside your
hook's `try`/`catch` and silently return a degraded result.

## Credentials and config

### Credentials

Declare required credential keys in `manifest.requiresCredential`:

```typescript
const manifest: PluginManifest = {
  name: "my-plugin",
  version: "1.0.0",
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
  pluginStorageDir: string; // <workspaceDir>/plugins-data/<name>/ (created by bootstrap)
  assistantVersion: string; // assistant semver — same value used by the loader
  //                          against your peerDependencies range
}
```

`pluginStorageDir` is a per-plugin writable directory. Use it for
persistent state — cache files, counters, anything that must survive an
assistant restart. The bootstrap creates it on demand.

## Tool, route, and skill contributions

Plugins can contribute model-visible capabilities alongside their
hooks. Each is optional.

### Tools (`plugin.tools`)

An array of `Tool` objects. The bootstrap registers them with the global
tool registry after `init()` succeeds, stamping `origin: "plugin"` and
`owner: { kind: "plugin", id: <plugin.name> }` so they live in a ref-count
namespace disjoint from real skills (a plugin whose `manifest.name`
happens to match a skill id cannot collide with that skill's
registrations).

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
succeeds; the runtime retains the opaque handle returned by each call
and uses those handles to unregister the plugin's routes on shutdown.
Handle-keyed unregistration is deliberate: two owners (plugin vs.
skill, or plugin vs. plugin) can legitimately declare the same regex,
and identity matching ensures one owner's teardown cannot evict
another owner's live routes.

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

## Cross-plugin communication

Plugins should not call each other directly. There is no cross-plugin
import API — a plugin's export surface is intentionally limited to the
`Plugin` object it registers.

For cross-cutting concerns (broadcasting events, reacting to
system-level changes), use the `assistantEventHub` pub/sub in
[`runtime/assistant-event-hub.ts`](../src/runtime/assistant-event-hub.ts).
The hub is the canonical place to publish events from inside the
assistant process and to subscribe from anywhere that has access to the
assistant's module graph.

Do not add new HTTP endpoints to implement plugin-to-plugin messaging
inside a single assistant process.

## Hot reload

**Not supported in v1.** Registering a plugin takes effect at assistant
startup only. To pick up a new or modified plugin:

```bash
vellum restart
```

The registry's internal state is not mutable at runtime. `init()` and
`onShutdown()` hooks are fired exactly once per assistant boot.

If you need hot reload for development, symlink your plugin directory
into `<workspaceDir>/plugins/` so edits propagate, and automate the restart
loop externally.

## Troubleshooting

### `external plugin X: peerDependencies["@vellumai/plugin-api"] requires "<range>" but assistant is <version> — loading anyway`

Logged at `error` level. Your plugin's declared
`peerDependencies["@vellumai/plugin-api"]` range does not include the
running assistant's version. The plugin still loads while the install
flow is being shaped, but a future release will turn this into a hard
rejection. Either widen the range in your `package.json` (typically by
bumping the major in `^X.Y.Z`) or upgrade the assistant.

### `external plugin X: peerDependencies["@vellumai/plugin-api"] is not a valid semver range — loading anyway`

Logged at `error` level, same lenient policy as above. The value declared
under `peerDependencies["@vellumai/plugin-api"]` is not parseable as a
semver range. Use a standard range expression such as `^0.8.0`,
`>=0.8.0 <0.10`, or an exact version.

### `external plugin X missing plugin-api peerDependency — loading without host-compat claim`

Warning, not an error. Your plugin's `package.json` does not declare a
`peerDependencies["@vellumai/plugin-api"]` entry, so the loader has no
host-compat range to check and loads the plugin without that guard. Add
the peerDep so future assistant upgrades surface incompatibility before
the plugin runs.

### "plugin X is already registered"

Two plugins tried to register under the same `manifest.name`. Names must
be globally unique. Rename one, or if this is a dev-reload issue,
restart the assistant.

### "plugin X requires credential Y but the credential store returned no value"

The credential named in `requiresCredential` is not set. Run:

```bash
vellum credentials set Y
```

…and restart the assistant.

### "plugin X config validation failed: …"

The config block under `config.plugins.<name>` failed the manifest's
parser. Check your config against the plugin's schema — the error
message carries the validator's diagnostic.

### Plugin not loading at all

- Confirm the directory is under `<workspaceDir>/plugins/`.
- Confirm it has a `register.ts` or `register.js` at the top level.
- Check the assistant's stderr for a line like
  `loaded user plugin (side-effect import completed)` or
  `Failed to load user plugin <dir>: <err>`. Import-time throws are
  logged but do not crash the assistant — the plugin is silently skipped
  otherwise.
- Verify `register.ts` calls `registerPlugin()` exactly once at module
  level. If the call is inside an unrelated conditional or wrapped in
  an async function that is never awaited, the registry won't see it.
