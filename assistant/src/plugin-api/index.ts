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
 * handles** for plugins that need to reach the assistant's live singletons
 * (subscribe to runtime events, read secrets). These resolve to the
 * assistant's own instances: the host parks the loaded plugin-api namespace
 * on `globalThis` at boot, and the workspace-level shim re-binds each
 * runtime export from there — so a plugin's
 * `import { assistantEventHub } from "@vellumai/plugin-api"` lands on the
 * same singleton the assistant uses, even when the daemon is a
 * `bun --compile` binary where an absolute-path import would load a
 * disjoint module copy.
 *
 * - {@link assistantEventHub} — the assistant's pub/sub hub for runtime events
 * - {@link getSecureKeyAsync} — read a secret from secure storage
 *
 * - {@link PluginInitContext} — passed to `init` hook at bootstrap
 * - {@link PluginShutdownContext} — passed to `shutdown` hook at teardown
 * - {@link UserPromptSubmitContext} — passed to `user-prompt-submit` hook,
 *   fired immediately before the agent loop receives a user's prompt
 * - {@link PostCompactContext} — passed to `post-compact` hook, fired after
 *   the agent loop compacts a conversation mid-turn to re-apply injections
 * - {@link PreModelCallContext} — passed to `pre-model-call` hook, fired
 *   before each provider call to edit the request / defer output streaming
 * - {@link PostToolUseContext} — passed to `post-tool-use` hook, fired once
 *   per tool result before it joins the provider-bound history
 * - {@link StopContext} — passed to `stop` hook, the definitive terminal hook
 *   fired exactly once when the turn ends (no continue capability)
 * - {@link AgentLoopExitReason} — why a turn reached its terminal state, carried
 *   on {@link StopContext} and the `agent_loop_exit` event
 * - {@link PostModelCallContext} — passed to `post-model-call` hook, fired at
 *   every model-call outcome (a finalized reply or a provider rejection) to
 *   transform content and decide whether to retry
 * - {@link PluginHookFn} — signature every lifecycle hook implements
 * - {@link PluginLogger} — pino-compatible logger shape on the contexts
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
export type {
  AgentLoopExitReason,
  PluginHookFn,
  PluginInitContext,
  PluginLogger,
  PluginShutdownContext,
  PostCompactContext,
  PostModelCallContext,
  PostModelCallDecision,
  PostToolUseContext,
  PreModelCallContext,
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
export { assistantEventHub } from "../runtime/assistant-event-hub.js";
export { getSecureKeyAsync } from "../security/secure-keys.js";
