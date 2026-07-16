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
├── routes/                    # HTTP routes, served under /x/plugins/<name>/
│   └── status.ts
├── skills/                    # On-demand instruction bundles
│   └── my-skill/
│       └── SKILL.md
├── apps/                      # Interactive apps served in the workspace panel
│   └── my-app/
│       └── src/               # (dist/ is generated — never committed)
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

One more path is runtime-generated rather than source: `apps/<app>/dist`, the compiled output the source watcher builds from an app's `src/`. Like the preserved entries, it is excluded from fingerprinting and drift detection, so the watcher's own compile is not seen as a source change and generated bundles never show as drift against the pinned commit. Ship only the app's `src/`; never commit `dist/`. See [apps.md](apps.md).

### State is plugin-owned

A plugin must be fully self-contained: every byte of durable state it keeps lives in `data/`, and its lifecycle hooks own that state end-to-end.

- **Create in `init`.** Open storage files (e.g. a SQLite database under `pluginStorageDir`) and apply the plugin's own schema in the `init` hook. Make it idempotent — `init` runs on every assistant boot, so `CREATE TABLE IF NOT EXISTS` plus in-place schema checks, not one-shot migrations.
- **Close in `shutdown`.** Release storage handles so shutdown and in-place plugin redeploys never leak them.
- **Purge in `conversation-deleted`.** Key per-conversation rows by conversation id and delete them when the hook fires, so data derived from a conversation does not outlive it.

The assistant's own database is internal — `@vellumai/plugin-api` exposes no handle to it, and a plugin must not persist state elsewhere in the workspace. Keeping everything in `data/` is also what makes uninstall clean: removing the plugin directory removes all of its state.

Each surface can also be dropped straight into the workspace at `/workspace/<surface>/<name>/` without wrapping it in a plugin. A plugin is what lets you ship several surfaces together as one installable unit.

Each surface's contract lives in its own reference file next to this one, linked from the surfaces table in `SKILL.md`.

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

The logger the host threads onto the contexts. Log through it rather than rolling your own.

| Export         | Kind | Purpose                                                                                                                                                                                                                                                                                                                         |
| -------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PluginLogger` | type | Pino-compatible logger shape present on the contexts. On agent-loop hook contexts it is bound per hook — pre-tagged with the hook name, your plugin, and the conversation / request identity when the context carries them — so no manual `{ plugin }` tagging is needed. On `InitContext` it is bound to `{ plugin: <name> }`. |

### Runtime handles

Values, not just types, that a plugin consumes at module-load or init time. A boot-time shim rebinds each from the assistant's own namespace, so they resolve to the same live singletons the assistant uses.

#### Events

| Export                       | Kind  | Purpose                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assistantEventHub`          | value | The assistant's pub/sub hub for runtime events. Subscribe to react to activity outside the hook chain.                                                                                                                                                                                                                                 |
| `AssistantEvent`             | type  | Payload shape of an event published on the hub.                                                                                                                                                                                                                                                                                        |
| `AssistantEventHub`          | type  | Interface of the event hub itself.                                                                                                                                                                                                                                                                                                     |
| `AssistantEventCallback`     | type  | Subscriber callback invoked for each matching event.                                                                                                                                                                                                                                                                                   |
| `AssistantEventFilter`       | type  | Filter narrowing which events a subscription receives.                                                                                                                                                                                                                                                                                |
| `AssistantEventSubscription` | type  | Handle returned by subscribing, used to unsubscribe.                                                                                                                                                                                                                                                                                   |

#### Model routing

| Export                  | Kind  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getModelProfiles`      | value | List this workspace's inference profiles in /model picker order, so a routing plugin can learn which profile keys exist before assigning one to `PreModelCallContext.modelProfile`. Reads live config, so call it at init to build a map once or per call.                                                                                                                                                                                                                |
| `doesSupportVision`    | value | Check whether a profile's resolved model can process image input. Takes a `ModelProfileInfo` entry from `getModelProfiles()` and resolves the effective (provider, model) by merging the profile over the workspace default and inferring the provider for model-only profiles. Handles mix profiles (true if any arm supports vision). Unknown models default to true (fail-open). Use this to gate image-processing logic on capability rather than model name strings. |
| `getConfiguredProvider` | value | Resolve a provider instance for a call site (typically 'inference'), optionally overriding the profile. Returns null when no provider is configured. A plugin that needs to run its own model call (e.g. captioning an image with a vision model) uses this to route through the workspace's credentials without supplying its own API key. Pair with `getModelProfiles()` and `doesSupportVision()` to pick the right profile.                                           |
| `ModelProfileInfo`      | type  | Shape of each entry `getModelProfiles()` returns: key, label, description, isActive, isDisabled, and isMix. Disabled profiles and weighted mix profiles are included and flagged; a mix is a valid target that splits the call across its constituents per conversation.                                                                                                                                                                                                  |

#### Credentials

| Export                     | Kind  | Purpose                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveCredential`       | value | Resolve a stored credential to its plaintext value (the same value `assistant credentials reveal` prints) from a UUID or a `service/field` reference. When a plugin is in context, resolution is scoped to credentials whose `field` matches the plugin's manifest name; outside any plugin it is unscoped. Throws `CredentialResolutionError` on failure. |
| `CredentialResolutionError` | class | Thrown when the credential ref does not resolve, the store is unreachable, or the credential is out of the plugin's scope. Catch it to degrade gracefully rather than crashing the hook.                                                                                                                                                                       |

#### Inference helpers

| Export                  | Kind  | Purpose                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveMediaSourceData` | value | Resolve an image or file content block's `source` to inline base64 bytes, whether the source is inline base64 or a persisted workspace reference (attachment-store row or a file on disk). Returns null when a reference can no longer be resolved. Use this to normalize media before passing it to a provider call.                                          |
| `isMaxTokensStopReason`  | value | Classify a provider stop reason: true when the turn was truncated at the output token cap (vs. a natural stop or a tool call). A `post-model-call` hook reads it off `PostModelCallContext.stopReason` to decide whether to continue a cut-off reply. See `references/hooks.md` for the post-model-call context.                                               |

#### Identity

| Export             | Kind  | Purpose                                                                                                                                                                                                                                                                                                              |
| ------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getAssistantName` | value | Read the assistant's display name from the workspace `IDENTITY.md`. Returns null when unset. A plugin that builds its own prompts (e.g. for its own inference) uses this to name the assistant actor without hardcoding a string.                                                                                     |
| `resolveUserName`  | value | Read the user's display name from the user profile under the given workspace directory. Returns null when unset. Pair with `getAssistantName` to populate identity fields in custom prompts.                                                                                                                        |

#### Embeddings

Host-resolved operations on the shared embedding and vector-store subsystem. Each reads live workspace config internally, so plugins hold no config. Async because the facade loads the embed graph lazily on first call.

| Export                          | Kind  | Purpose                                                                                                                                                                                                              |
| ------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `embedAndUpsert`                | value | Embed a text or multimodal input and upsert the vector into the host's vector store. Returns the embedding and the upserted id.                                                                                      |
| `selectedBackendSupportsMultimodal` | value | Check whether the currently selected embedding backend supports multimodal input (text + image). Gate multimodal embedding logic on this rather than assuming a specific backend.                                    |

#### Skills catalog

Host-resolved: catalog load, install-state resolution, feature-flag gating, and install-meta reads are composed internally. Async because the facade loads the catalog/flag graph lazily on first call.

| Export               | Kind  | Purpose                                                                                                                            |
| -------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `listCatalogSkills`  | value | List the remote skill catalog with resolved states. Use this to discover skills available for installation.                        |
| `listInstalledSkills` | value | List installed skills with install-state resolution. Use this to enumerate what is already available on the workspace.              |
| `ResolvedSkillEntry` | type  | Shape of each entry returned by both list functions: name, display name, description, installed state, and metadata.              |

#### Message content projections

Pure projections of the persisted message content format (a JSON content-block array) to a string, so plugins that read conversation history stay agnostic to how content is persisted.

| Export                              | Kind  | Purpose                                                                                                                                                                                                              |
| ----------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stringifyMessageContent`           | value | Extract spoken text only from stored content (text blocks; tool calls/results, thinking, and media are dropped). Use this when you need the human-readable reply text.                                              |
| `extractTextFromStoredMessageContent` | value | Render the full annotated transcript (tool calls with inputs, tool results, thinking, image/file markers). Use this when you need the complete structured view of a message.                                        |

#### Conversation history

Reads and writes on the host conversation store (rows, message history, processing state, disk-view paths) plus the lexical message-search surface. Every operation takes explicit parameters; nothing is resolved from config. Async because the facade loads the DB store graph lazily on first call.

| Export                     | Kind  | Purpose                                                                                                                                                                                                              |
| -------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addMessage`               | value | Append a message to a conversation. Provide the conversation id, role, content, and optional metadata.                                                                                                              |
| `buildMessageExcerpt`      | value | Build a short text excerpt from a message, for display or logging.                                                                                                                                                   |
| `deleteConversation`       | value | Delete a conversation and all its messages. Fires the `conversation-deleted` hook.                                                                                                                                   |
| `getConversation`          | value | Get a conversation's metadata row by id. Returns null when not found.                                                                                                                                                |
| `getConversationDirPath`   | value | Get the on-disk directory path for a conversation's persisted files.                                                                                                                                                  |
| `getMessages`             | value | Get all messages for a conversation, in order.                                                                                                                                                                       |
| `hasLexicalTokens`         | value | Check whether a string contains lexical search tokens (useful before calling `searchMessageIdsLexical`).                                                                                                            |
| `isConversationProcessing` | value | Check whether a conversation is currently running an agent loop. Use this to gate plugins that should not fire while a turn is in progress.                                                                          |
| `listConversations`        | value | List all conversations with their metadata rows.                                                                                                                                                                     |
| `parseMessageMetadata`     | value | Parse the metadata JSON on a stored message into a typed object.                                                                                                                                                    |
| `searchMessageIdsLexical`  | value | Lexical search over message content, returning matching message ids. Use `hasLexicalTokens` first to short-circuit on empty queries.                                                                                |
| `syncMessageToDisk`        | value | Persist a single message to the conversation's on-disk directory.                                                                                                                                                    |
| `updateMessageMetadata`    | value | Update the metadata on a stored message.                                                                                                                                                                              |
| `ConversationRow`          | type  | Shape of a conversation metadata row: id, title, created/updated timestamps, and processing state.                                                                                                                  |

#### Text-to-speech

| Export                  | Kind  | Purpose                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `synthesizeText`        | value | Synthesize text to speech through the assistant's globally configured TTS provider (ElevenLabs, Fish Audio, etc.). Returns a `TtsSynthesisResult` (Buffer + MIME type). Text is sanitized internally (markdown/URLs/emoji stripped), so callers can pass raw model output directly. A plugin that needs voice output uses this instead of managing TTS credentials. |
| `TtsSynthesisError`     | class | Thrown when TTS synthesis fails (provider error, network, config). Catch it to degrade gracefully.                                                                                                                                                                                                                                                                  |
| `SynthesizeTextOptions` | type  | Options for `synthesizeText`: voice id, speed, and other provider-specific knobs.                                                                                                                                                                                                                                                                                    |
| `TtsSynthesisResult`    | type  | Return shape of `synthesizeText`: `{ audio: Buffer, mimeType: string }`.                                                                                                                                                                                                                                                                                             |

#### Conversation turns

| Export                     | Kind  | Purpose                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runConversationTurn`     | value | Run a full conversation turn (persist user message, execute the agent loop with history/tools/compaction/injections, return the assistant's full content-block response). Accepts `ContentBlock[]` input (text, images, files) and an optional conversation id (creates a new conversation when omitted). Plugins that need to drive conversation turns (e.g. a meeting bot flushing a transcript excerpt) should prefer this over the stateless `provider.sendMessage()` call. |
| `RunConversationTurnOptions` | type  | Options for `runConversationTurn`: input content blocks, conversation id, and turn parameters.                                                                                                                                                                                                                                                                   |
| `RunConversationTurnResult`  | type  | Return shape of `runConversationTurn`: the assistant's response as `ContentBlock[]`.                                                                                                                                                                                                                                                                              |

#### CLI data

| Export             | Kind  | Purpose                                                                                                                                                                                                              |
| ------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI_COMMAND_HELP` | value | Declarative help data for the top-level `assistant` CLI commands that have adopted the static-help split. Pure data: iterate the fields directly. A plugin that surfaces CLI capabilities (e.g. a capability indexer) reads this instead of importing the CLI action graph. |

## Surfaces not yet available in plugins

The assistant supports these surfaces today, but they are not yet contributed through the plugin system. They may be added in the future.

| Surface        | What it does                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| Schedules      | Cron-style triggers that fire on a recurring schedule.                                                        |
| Artifacts      | Versioned outputs the assistant produces and tracks (documents, diagrams, generated files).                   |
| Webhooks       | Inbound HTTP endpoints that deliver external events into the assistant.                                       |
| Prompts        | Reusable system prompt fragments and templates.                                                               |
| UIs            | Custom UI surfaces rendered in the conversation or workspace.                                                 |
| Bin            | CLI commands the assistant exposes as tools.                                                                  |
| Integrations   | OAuth-connected and MCP-connected external services (Google, Linear, Slack, etc.) with credential management. |
| Slash commands | Shortcuts triggered by typing `/` in the conversation, expanding into prompts or actions.                     |
