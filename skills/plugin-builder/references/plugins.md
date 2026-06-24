# Plugins

A plugin is a directory whose `package.json` is the manifest and whose subdirectories are the surfaces it contributes. This reference covers the directory layout, the manifest fields, and the single public package every surface imports from.

## Directory layout

A plugin lives at `<workspaceDir>/plugins/<name>/`. The host introspects the directory at load time: the manifest names the plugin, and each named subdirectory is discovered by convention.

```
my-plugin/
├── package.json               # Manifest (required)
├── README.md                  # Optional plugin docs
├── hooks/                     # Lifecycle hooks, one per file
│   ├── init.ts
│   └── pre-model-call.ts
├── tools/                     # Model-visible tools, one per file
│   └── example.ts
├── skills/                    # On-demand instruction bundles
│   └── my-skill/
│       └── SKILL.md
└── src/                       # Internal modules (NOT walked by the loader)
    └── state.ts
```

Loader rules:

- **Compiled files win.** When both a `.js` and a `.ts` exist for the same basename, the `.js` is used, matching compiled-binary semantics.
- **Missing directories are skipped.** A plugin contributes only the surfaces it ships. Absent surface directories are silently omitted.
- **A broken surface file fails only itself.** A surface file present but missing a usable default export is logged with attribution and skipped. Sibling plugins keep loading.
- **`src/` is yours.** Only the named surface directories are walked. Put shared helpers in `src/` (or any other directory) and import from them normally.
- **Loading is time-boxed.** Each plugin has a 10s import budget. Anything slower is treated as a load failure and the plugin is skipped.

Each surface can also be dropped straight into the workspace at `/workspace/<surface>/<name>/` without wrapping it in a plugin. A plugin is what lets you ship several surfaces together as one installable unit.

## The manifest

Every plugin has a `package.json`. The loader reads three fields and passes everything else through untouched, so your editor, linter, and publish tooling keep working as normal.

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

- **`name`** (required). Any npm-style name. The loader strips the scope (`@you/`) for the in-runtime plugin name, and duplicate names fail registration.
- **`version`**. Informational, and defaults to `0.0.0` when absent.
- **`peerDependencies["@vellumai/plugin-api"]`**. A semver range checked against the running assistant. While plugins are in beta a mismatch is logged but does not block load. Once the install path stabilizes the mismatch will harden into a hard reject, so pin a real range.
- **`vellum`**. Reserved for future use.

## The @vellumai/plugin-api surface

Plugins import everything they need from a single package, [`@vellumai/plugin-api`](https://github.com/vellum-ai/vellum-assistant/tree/main/assistant/src/plugin-api). It is the only supported contract: anything not exported from there is assistant-internal and can change without notice. Most of the surface is types (the contexts the host hands your code), with a small set of runtime handles that resolve to the assistant's live singletons.

### Hook contexts and constants

The context shape the host hands to each lifecycle hook, the hook signature itself, and the wired hook-name constant. Each context's full field contract is documented in `references/hooks.md`.

| Export | Kind | Purpose |
| ------ | ---- | ------- |
| `HOOKS` | const | Wired hook names keyed by constant (INIT, PRE_MODEL_CALL, and so on). Reference hooks by this instead of free-form strings. |
| `HookName` | type | Union of every wired hook name declared in HOOKS. |
| `PluginHookFn` | type | Signature every hook implements: `(ctx) => Promise<Partial<ctx> \| void>`. |
| `PluginInitContext` | type | Passed to the init hook at bootstrap. |
| `PluginShutdownContext` | type | Passed to the shutdown hook at teardown. |
| `UserPromptSubmitContext` | type | Passed to user-prompt-submit, before a turn's messages reach the agent loop. |
| `PreModelCallContext` | type | Passed to pre-model-call, before each provider call. |
| `PostToolUseContext` | type | Passed to post-tool-use, once per tool result. |
| `PostModelCallContext` | type | Passed to post-model-call at every model-call outcome (a finalized reply or a provider rejection); carries the continue decision. |
| `PostCompactContext` | type | Passed to post-compact, after the loop compacts a conversation mid-turn. |
| `StopContext` | type | Passed to stop, the terminal hook, once the turn has committed to ending. |
| `PostModelCallDecision` | type | The post-model-call decision shape: whether to end the turn or continue. |
| `AgentLoopExitReason` | type | Which terminal state a turn reached, carried on StopContext. |

### Tool types

The author-facing tool spec and the shapes passed to and returned from a tool's `execute` method. Each is documented in full in `references/tools.md`.

| Export | Kind | Purpose |
| ------ | ---- | ------- |
| `ToolDefinition` | type | Author-facing tool spec, the default-export shape for a `tools/<name>.ts` file. |
| `ToolContext` | type | Runtime context passed as the second argument to a tool's execute. |
| `ToolExecutionResult` | type | Return shape of a tool's execute: `{ content, isError }`. |
| `RiskLevel` | enum | Risk bands (low, medium, high) that drive default permission gating for a tool. |

### Logging

The logger the host binds to your plugin name and threads onto the contexts. Log through it rather than rolling your own.

| Export | Kind | Purpose |
| ------ | ---- | ------- |
| `PluginLogger` | type | Pino-compatible logger shape, bound to `{ plugin: <name> }` and present on the contexts. |

### Runtime handles

Values, not just types, that a plugin consumes at module-load or init time. A boot-time shim rebinds each from the assistant's own namespace, so they resolve to the same live singletons the assistant uses.

| Export | Kind | Purpose |
| ------ | ---- | ------- |
| `assistantEventHub` | value | The assistant's pub/sub hub for runtime events. Subscribe to react to activity outside the hook chain. |
| `getModelProfiles` | value | List this workspace's inference profiles in /model picker order, so a routing plugin can learn which profile keys exist before assigning one to `PreModelCallContext.modelProfile`. Reads live config, so call it at init to build a map once or per call. |
| `doesSupportVision` | value | Check whether a profile's resolved model can process image input. Takes a `ModelProfileInfo` entry from `getModelProfiles()` and resolves the effective (provider, model) by merging the profile over the workspace default and inferring the provider for model-only profiles. Handles mix profiles (true if any arm supports vision). Unknown models default to true (fail-open). Use this to gate image-processing logic on capability rather than model name strings. |
| `getConfiguredProvider` | value | Resolve a provider instance for a call site (typically 'inference'), optionally overriding the profile. Returns null when no provider is configured. A plugin that needs to run its own model call (e.g. captioning an image with a vision model) uses this to route through the workspace's credentials without supplying its own API key. Pair with `getModelProfiles()` and `doesSupportVision()` to pick the right profile. |
| `ModelProfileInfo` | type | Shape of each entry `getModelProfiles()` returns: key, label, description, isActive, isDisabled, and isMix. Disabled profiles and weighted mix profiles are included and flagged; a mix is a valid target that splits the call across its constituents per conversation. |
| `AssistantEvent` | type | Payload shape of an event published on the hub. |
| `AssistantEventHub` | type | Interface of the event hub itself. |
| `AssistantEventCallback` | type | Subscriber callback invoked for each matching event. |
| `AssistantEventFilter` | type | Filter narrowing which events a subscription receives. |
| `AssistantEventSubscription` | type | Handle returned by subscribing, used to unsubscribe. |
