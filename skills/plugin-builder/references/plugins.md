# Plugins

A plugin is a directory whose `package.json` is the manifest and whose subdirectories are the surfaces it contributes. This reference covers the directory layout, the manifest fields, and the single public package every surface imports from.

## Directory layout

A plugin lives at `<workspaceDir>/plugins/<name>/`. The host introspects the directory at load time: the manifest names the plugin, and each named subdirectory is discovered by convention.

```
my-plugin/
├── package.json               # Manifest (required)
├── README.md                  # Optional plugin docs
├── config.json                # User-editable config (preserved across upgrades)
├── data/                      # Runtime data directory (preserved across upgrades)
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

- **Compiled files win.** When both a `.js` and a `.ts` exist for the same basename, the `.js` is used, matching compiled-binary semantics. Clean stale `.js` files when iterating on `.ts` source, or the loader will silently pick up old code.
- **Missing directories are skipped.** A plugin contributes only the surfaces it ships. Absent surface directories are silently omitted.
- **A broken surface file fails only itself.** A surface file present but missing a usable default export is logged with attribution and skipped. Sibling plugins keep loading.
- **`src/` is yours.** Only the named surface directories are walked. Put shared helpers in `src/` (or any other directory) and import from them normally.
- **Loading is time-boxed.** Each plugin has a 10s import budget. Anything slower is treated as a load failure and the plugin is skipped.

### Preserved entries

Three entries at the plugin root are runtime-owned state, not part of the plugin's source tree. They are excluded from fingerprinting, drift detection, and upgrades, so user edits and runtime data never show as drift and survive re-installs:

| Entry         | Purpose                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `config.json` | User-editable plugin config. Read by the `init` hook via `InitContext.config`. Ship a default in your repo; users edit it in place. |
| `data/`       | Runtime data directory. The `init` hook receives its path via `InitContext.pluginStorageDir`. Write whatever you want here.         |
| `.disabled`   | Sentinel file created by `assistant plugins disable`. Presence skips the plugin entirely (no hooks, no tools).                      |

Uninstalling a plugin (`assistant plugins uninstall`) removes the entire plugin directory, so `config.json`, `data/`, and `.disabled` go with it. No orphaned state is left behind.

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

- **`name`** (required). Any npm-style name. The loader strips the scope (`@you/`) for the in-runtime plugin name, and duplicate names fail registration. The unscoped portion must be kebab-case (e.g. `my-plugin`, not `myPlugin` or `my_plugin`), matching the convention used for catalog entries and directory names.
- **`version`**. Informational, and defaults to `0.0.0` when absent.
- **`peerDependencies["@vellumai/plugin-api"]`**. A semver range checked against the running assistant. While plugins are in beta a mismatch is logged but does not block load. Once the install path stabilizes the mismatch will harden into a hard reject, so pin a real range.
- **`vellum`**. Reserved for future use.

The marketplace catalog entry can point at a subdirectory of a repo using `source.path` in the catalog manifest. See `references/distribution.md` for the full `source.path` field and the catalog manifest schema.

## The @vellumai/plugin-api surface

Plugins import everything they need from a single package, [`@vellumai/plugin-api`](https://github.com/vellum-ai/vellum-assistant/tree/main/assistant/src/plugin-api). It is the only supported contract: anything not exported from there is assistant-internal and can change without notice. Most of the surface is types (the contexts the host hands your code), with a small set of runtime handles that resolve to the assistant's live singletons.

The hook-related exports (context types, `HOOKS` constant, `HookFunction` signature) are documented in `references/hooks.md`. The tool-related exports (`ToolDefinition`, `ToolContext`, `ToolExecutionResult`, `RiskLevel`) are documented in `references/tools.md`. The remaining exports are covered below.

### Logging

The logger the host binds to your plugin name and threads onto the contexts. Log through it rather than rolling your own.

| Export         | Kind | Purpose                                                                                  |
| -------------- | ---- | ---------------------------------------------------------------------------------------- |
| `PluginLogger` | type | Pino-compatible logger shape, bound to `{ plugin: <name> }` and present on the contexts. |

### Runtime handles

Values, not just types, that a plugin consumes at module-load or init time. A boot-time shim rebinds each from the assistant's own namespace, so they resolve to the same live singletons the assistant uses.

| Export                       | Kind  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assistantEventHub`          | value | The assistant's pub/sub hub for runtime events. Subscribe to react to activity outside the hook chain.                                                                                                                                                                                                                                                                                                                                                                    |
| `getModelProfiles`           | value | List this workspace's inference profiles in /model picker order, so a routing plugin can learn which profile keys exist before assigning one to `PreModelCallContext.modelProfile`. Reads live config, so call it at init to build a map once or per call.                                                                                                                                                                                                                |
| `doesSupportVision`          | value | Check whether a profile's resolved model can process image input. Takes a `ModelProfileInfo` entry from `getModelProfiles()` and resolves the effective (provider, model) by merging the profile over the workspace default and inferring the provider for model-only profiles. Handles mix profiles (true if any arm supports vision). Unknown models default to true (fail-open). Use this to gate image-processing logic on capability rather than model name strings. |
| `getConfiguredProvider`      | value | Resolve a provider instance for a call site (typically 'inference'), optionally overriding the profile. Returns null when no provider is configured. A plugin that needs to run its own model call (e.g. captioning an image with a vision model) uses this to route through the workspace's credentials without supplying its own API key. Pair with `getModelProfiles()` and `doesSupportVision()` to pick the right profile.                                           |
| `ModelProfileInfo`           | type  | Shape of each entry `getModelProfiles()` returns: key, label, description, isActive, isDisabled, and isMix. Disabled profiles and weighted mix profiles are included and flagged; a mix is a valid target that splits the call across its constituents per conversation.                                                                                                                                                                                                  |
| `AssistantEvent`             | type  | Payload shape of an event published on the hub.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `AssistantEventHub`          | type  | Interface of the event hub itself.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `AssistantEventCallback`     | type  | Subscriber callback invoked for each matching event.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `AssistantEventFilter`       | type  | Filter narrowing which events a subscription receives.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `AssistantEventSubscription` | type  | Handle returned by subscribing, used to unsubscribe.                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Surfaces not yet available in plugins

The assistant supports these surfaces today, but they are not yet contributed through the plugin system. They may be added in the future.

| Surface        | What it does                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| Schedules      | Cron-style triggers that fire on a recurring schedule.                                                        |
| Apps           | Persistent interactive apps (dashboards, games, tools) served in the workspace panel.                         |
| Routes         | HTTP routes the assistant exposes, used for webhooks and integrations.                                        |
| Artifacts      | Versioned outputs the assistant produces and tracks (documents, diagrams, generated files).                   |
| Webhooks       | Inbound HTTP endpoints that deliver external events into the assistant.                                       |
| Prompts        | Reusable system prompt fragments and templates.                                                               |
| UIs            | Custom UI surfaces rendered in the conversation or workspace.                                                 |
| Bin            | CLI commands the assistant exposes as tools.                                                                  |
| Integrations   | OAuth-connected and MCP-connected external services (Google, Linear, Slack, etc.) with credential management. |
| Slash commands | Shortcuts triggered by typing `/` in the conversation, expanding into prompts or actions.                     |
