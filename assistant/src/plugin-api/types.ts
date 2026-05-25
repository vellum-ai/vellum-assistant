/**
 * Public plugin-API types — the canonical contract for
 * `@vellumai/plugin-api`. Adding fields is non-breaking; renaming /
 * removing is breaking and gated on a major bump.
 */

import type { Message } from "../providers/types.js";

export type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../tools/types.js";
export { RiskLevel } from "../tools/types.js";

// ─── Logger ──────────────────────────────────────────────────────────────────

/**
 * Minimal pino-compatible logger surface handed to plugin hooks. The host
 * supplies a pino child logger bound to `{ plugin: <name> }`; this
 * interface intentionally captures only the two call shapes plugin code
 * needs (structured object + optional message), so the public surface
 * doesn't take a dependency on pino's full type machinery.
 *
 * Each method accepts a structured-fields object followed by an optional
 * message string. Plugin authors that need pino's wider API (`child()`,
 * `level`, etc.) can cast to their own narrower interface in plugin code
 * — but the canonical contract here covers the 99% case.
 */
export interface PluginLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
}

// ─── Init context ────────────────────────────────────────────────────────────

/**
 * Context passed to `Plugin.init()` during bootstrap. Carries resolved
 * config/credentials, a pino-compatible logger scoped to the plugin, a
 * per-plugin writable data directory, and the assistant's version metadata.
 */
export interface PluginInitContext {
  /** Parsed config for this plugin (may be `unknown` until the manifest validates). */
  config: unknown;
  /** Resolved credential values keyed by the entries of `manifest.requiresCredential`. */
  credentials: Record<string, string>;
  /** Pino-compatible child logger bound to `{ plugin: <name> }`. */
  logger: PluginLogger;
  /** Absolute path to `<workspaceDir>/plugins-data/<plugin>/` (created by bootstrap). */
  pluginStorageDir: string;
  /**
   * Assistant semver. Plugins can compare against this for defensive
   * runtime checks — but the canonical compat contract is the host
   * version against the plugin's `peerDependencies["@vellumai/plugin-api"]`
   * semver range, enforced at load time by the external-plugin loader.
   */
  assistantVersion: string;
}

// ─── Shutdown context ────────────────────────────────────────────────────────

/**
 * Context passed to the `shutdown` hook during daemon teardown. Kept
 * intentionally narrower than {@link PluginInitContext} — most teardown
 * paths only need to know which assistant version they're shutting
 * down against (e.g. for version-conditional cleanup of state files
 * written by a previous boot).
 *
 * Additional fields may be added as concrete plugin needs surface; the
 * `assistantVersion` field mirrors the init context's so plugins that
 * stash a version stamp at init can compare against the same name on
 * tear-down without keeping their own copy.
 */
export interface PluginShutdownContext {
  /** Assistant semver for compatibility checks inside the plugin. */
  assistantVersion: string;
}

// ─── User-prompt-submit hook context ─────────────────────────────────────────

/**
 * Context passed to the `user-prompt-submit` hook. Fires once per user
 * turn, after the agent loop has prepared the message list (PKB / NOW /
 * memory-graph injections, history repair, overflow reduction all already
 * applied) and immediately before the messages are handed to the agent
 * loop's tool/LLM iteration.
 *
 * The hook may transform `latestMessages` either by mutating it in place
 * (`push` / `splice` / `length = 0`) or by returning a new context with
 * a fresh `latestMessages` array — see {@link PluginHookFn}'s polymorphic
 * return shape. The daemon threads the final `latestMessages` value into
 * `agentLoop.run()` as the run-messages argument.
 *
 * `originalMessages` is the user's original message list, frozen for the
 * hook. Plugins should treat it as a stable reference point if they need
 * to recover from earlier transformations or compare against the pristine
 * state.
 *
 * Multiple plugins' hooks chain in registration order — each plugin's
 * hook sees the previous plugin's mutations (whether by reassignment or
 * in-place mutation).
 */
export interface UserPromptSubmitContext {
  /** Conversation ID the user prompt was submitted on. */
  readonly conversationId: string;
  /**
   * The user's original message list, immutable for the hook. Plugins
   * may snapshot or compare against this but MUST NOT mutate it.
   */
  readonly originalMessages: ReadonlyArray<Message>;
  /**
   * The working message list that flows into `agentLoop.run`. Plugins
   * may mutate this in place or replace it by returning a new context.
   */
  latestMessages: Message[];
}
