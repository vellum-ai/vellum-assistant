/**
 * Public plugin-API types.
 *
 * This module is the entry point plugin authors land on when they import
 * from `@vellumai/plugin-api`. The shapes here are the canonical public
 * contract — anything exported is part of the surface that semver gates.
 *
 * ## Tool-execution types
 *
 * `ToolContext` and `ToolExecutionResult` are re-exports of the narrow,
 * stable bases defined alongside their daemon-internal counterparts in
 * `assistant/src/tools/types.ts`. The daemon-internal `ToolContext` /
 * `ToolExecutionResult` (with CES, trust classification, lifecycle
 * events, sensitive-output bindings, risk metadata, etc.) `extends`
 * the public bases, so the runtime can hand plugins the full value
 * without a manual cast and tsc enforces the structural relationship.
 * Plugin tools see the narrow surface only — they MUST NOT set fields
 * that belong to the daemon-internal extension.
 *
 * ## Hook contexts
 *
 * The init / shutdown hook contexts are owned by this module directly.
 * They have no daemon-internal extension today (the daemon constructs
 * and hands them straight through), so there's nothing to inherit from.
 *
 * ## Compatibility
 *
 * Adding fields to any public shape is non-breaking. Renaming or
 * removing fields is breaking and gated on a major bump of
 * `@vellumai/plugin-api`.
 */

// ─── Tool-execution types (re-exported from daemon source-of-truth) ──────────

export type {
  PluginToolContext as ToolContext,
  PluginToolExecutionResult as ToolExecutionResult,
} from "../tools/types.js";

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
