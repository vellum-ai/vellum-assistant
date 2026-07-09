/**
 * Public entry point for the `@vellumai/plugin-api` package.
 *
 * Plugin authors import from `"@vellumai/plugin-api"`; this file is what
 * their import lands on (directly via the published npm package, or via a
 * boot-time shim that re-exports from the assistant binary's embedded
 * bundle).
 *
 * Keep this file's surface stable across minor/patch releases. Anything
 * exported here is part of the public contract.
 *
 * ## Surface today
 *
 * The primary authoring model is **declarative**: a plugin is a directory
 * whose `package.json` is the manifest and whose `hooks/` / `tools/` /
 * `skills/` / `routes/` subdirectories are the contributions. The host
 * introspects the directory at load time and wires it into the runtime.
 *
 * Most of what this module exposes is therefore types: the context shapes
 * the host hands to plugin hooks, and the logger shape they include.
 *
 * Alongside those types, the module exposes a small set of **runtime
 * handles for plugins that need to reach the assistant's live singletons
 * (subscribe to runtime events, inspect inference profiles). These resolve to the
 * assistant's own instances: the host parks the loaded plugin-api namespace
 * on `globalThis` at boot, and the workspace-level shim re-binds each
 * runtime export from there — so a plugin's
 * `import { assistantEventHub } from "@vellumai/plugin-api"` lands on the
 * same singleton the assistant uses, even when the daemon is a
 * `bun --compile` binary where an absolute-path import would load a
 * disjoint module copy.
 *
 * - {@link assistantEventHub} — the assistant's pub/sub hub for runtime events
 * - {@link getModelProfiles} — list the workspace inference profiles a plugin
 *   can route to (e.g. a model router building its category → profile map)
 * - {@link getConfiguredProvider} — resolve a {@link Provider} for a call site
 *   (optionally overriding the profile) and run inference through the
 *   workspace's configured profiles and credentials — no plugin-supplied API key
 *
 * - {@link InitContext} — passed to `init` hook at bootstrap
 * - {@link ShutdownContext} — passed to `shutdown` hook at teardown
 * - {@link UserPromptSubmitContext} — passed to `user-prompt-submit` hook,
 *   fired immediately before the agent loop receives a user's prompt
 * - {@link PostCompactContext} — passed to `post-compact` hook, fired after
 *   the agent loop compacts a conversation mid-turn to re-apply injections
 * - {@link PreModelCallContext} — passed to `pre-model-call` hook, fired
 *   before each provider call to edit the request, route it to a different
 *   inference profile, or defer output streaming
 * - {@link PostToolUseContext} — passed to `post-tool-use` hook, fired once
 *   per tool result before it joins the provider-bound history
 * - {@link StopContext} — passed to `stop` hook, the definitive terminal hook
 *   fired exactly once when the turn ends (no continue capability)
 * - {@link AgentLoopExitReason} — why a turn reached its terminal state, carried
 *   on {@link StopContext} and the `agent_loop_exit` event
 * - {@link PostModelCallContext} — passed to `post-model-call` hook, fired at
 *   every model-call outcome (a finalized reply or a provider rejection) to
 *   transform content and decide whether to retry
 * - {@link HookFunction} — signature every lifecycle hook implements
 * - {@link HookBroadcast} — the `ctx.broadcast(detail)` signature: emit a
 *   transient `hook_event` to any UI watching the conversation
 * - {@link PluginLogger} — pino-compatible logger shape on the contexts,
 *   pre-tagged per hook with the hook name and owning plugin
 * - {@link ToolDefinition} — author-facing tool spec (default-export shape
 *   for both plugin tool files and workspace tool files)
 * - {@link ToolContext} — passed to a plugin tool's `execute` method
 * - {@link ToolExecutionResult} — return shape of a plugin tool's `execute`
 */

export type { HookName } from "./constants.js";
export { HOOKS } from "./constants.js";
// Conversation message/content shapes. A hook receives the live message
// history (e.g. `PostToolUseContext.latestMessages: Message[]`), so plugins
// that inspect or narrow content blocks — reading a `tool_use` block's input,
// matching a `tool_result` — need to name these types.
export type {
  ContentBlock,
  FileContent,
  ImageContent,
  Message,
  RedactedThinkingContent,
  ServerToolUseContent,
  TextContent,
  ThinkingContent,
  ToolResultContent,
  ToolUseContent,
  WebSearchToolResultContent,
} from "../providers/types.js";
// Provider + inference types. A plugin that runs its own inference through
// `getConfiguredProvider` names these to type the provider handle it gets back,
// the request options it passes to `sendMessage`, and the response.
export type {
  Provider,
  ProviderEvent,
  ProviderResponse,
  SendMessageConfig,
  SendMessageOptions,
} from "../providers/types.js";
// Call-site identifier accepted by `getConfiguredProvider`. Plugins typically
// pass `"inference"` (the general-purpose call site) and pick the model via the
// `overrideProfile` option.
export type { LLMCallSite } from "../config/schemas/llm.js";
export type {
  AgentLoopExitReason,
  ConversationDeletedContext,
  HookBroadcast,
  HookFunction,
  InitContext,
  ModelProfileInfo,
  PluginLogger,
  PostCompactContext,
  PostModelCallContext,
  PostModelCallDecision,
  PostToolUseContext,
  PreModelCallContext,
  ShutdownContext,
  StopContext,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
  UserPromptSubmitContext,
} from "./types.js";
export { RiskLevel } from "./types.js";

// ─── Runtime handles ─────────────────────────────────────────────────────────
// Values (not just types) that plugins consume at module-load / init time.
// Workspace-local plugins resolve these via the boot-time shim, which
// re-binds each from the assistant's globalThis-parked namespace so they
// share module identity with the assistant's own singletons.
export type { AssistantEvent } from "../runtime/assistant-event.js";
export type {
  AssistantEventCallback,
  AssistantEventFilter,
  AssistantEventHub,
  AssistantEventSubscription,
} from "../runtime/assistant-event-hub.js";
// The hub plugins receive is a capability-restricted facade over the daemon
// singleton (see `event-hub-facade.ts`): plugins may `subscribe` to runtime
// events (shared subscriber state), `publish` non-host events, and check
// `hasSubscribersForEvent`. `publish` refuses daemon-to-client host-proxy
// control events (`host_*`), and methods that return live subscriber callbacks
// or mutate hub state are withheld — both would let a plugin drive privileged
// host execution without the host proxies' approval gate.
export type { PluginEventHub } from "./event-hub-facade.js";
export { pluginAssistantEventHub as assistantEventHub } from "./event-hub-facade.js";
export { getModelProfiles } from "./model-profiles.js";
// Check whether a model or profile can process image input. Accepts a concrete
// model id, a profile key, or a `ModelProfileInfo`; a bare string is resolved
// as a model id first and then as a profile key. Profile resolution merges over
// the workspace default and infers the provider for model-only profiles, then
// looks up the model catalog's `supportsVision` flag (mix profiles are
// vision-capable if any arm is). Returns false when nothing resolves.
export { doesSupportVision } from "./vision-support.js";
// Resolve a provider for a call site (optionally overriding the profile) so a
// plugin can run inference through the workspace's configured profiles and
// credentials — managed-proxy or BYOK — without supplying its own API key.
// Pair with `getModelProfiles` to pick a profile. Returns `null` when no
// provider is configured. By default `overrideProfile` layers below any
// per-call-site config the workspace has pinned (e.g. a cheap `inference`
// profile), so it loses to that pin; pass `forceOverrideProfile: true` to
// float the chosen profile above the call-site layers when the plugin must
// run on a specific profile regardless of workspace tuning.
export { getConfiguredProvider } from "../providers/provider-send-message.js";
// Resolve an image/file block's media `source` to its bytes as inline base64,
// whether the source is inline base64 or a persisted workspace reference
// (attachment-store row or a file on disk). Returns null when a reference can no
// longer be read. Plugins that need the raw bytes of a media block — captioning
// an image, embedding it, re-encoding it — use this instead of reaching into
// the host attachment store, so they stay agnostic to how media is persisted.
export { resolveMediaSourceData } from "../providers/media-resolve.js";
// Classify a provider stop reason: whether the turn was truncated at the
// output token cap (vs. a natural stop or a tool call). A `post-model-call`
// hook reads it off `PostModelCallContext.stopReason` to decide whether to
// continue a cut-off reply.
export { isMaxTokensStopReason } from "../providers/stop-reasons.js";
// Identity reads — "who is the assistant and the user." A plugin that builds
// its own prompts (e.g. for its own inference) names the actor via these.
// Backed by the workspace `IDENTITY.md` / user profile; each returns null when
// unset. `resolveUserName` reads the profile under the given workspace dir.
export {
  getAssistantName,
  resolveUserName,
} from "../daemon/identity-helpers.js";
