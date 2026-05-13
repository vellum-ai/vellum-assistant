/**
 * Public plugin-API types.
 *
 * This module is the source-of-truth for types that plugin authors depend on.
 * The rest of the assistant imports from here via relative paths
 * (`../plugin-api/types.js`). At publish time, this file's contents are
 * bundled into the `@vellumai/plugin-api` npm package; at runtime in the
 * assistant binary, the same source is reachable to user plugins via a
 * boot-time shim that re-exports from the embedded bundle.
 *
 * Today this module exposes the hook contexts (`PluginInitContext`,
 * `PluginShutdownContext`), the `PluginLogger` shape they reference,
 * and the tool-execution contract (`ToolContext`, `ToolExecutionResult`)
 * that plugin-authored tools rely on. Additional public types migrate
 * over in follow-up PRs as the surface stabilizes.
 *
 * Internal-only types (pipeline shapes, middleware, manifest validation,
 * etc.) stay in `assistant/src/plugins/types.ts` until they're ready to
 * become public. The full daemon-side `ToolContext` /
 * `ToolExecutionResult` (with CES, trust classification, lifecycle
 * events, etc.) live in `assistant/src/tools/types.ts`; the public
 * shape here is intentionally a narrow, stable subset that plugin
 * tools can pattern-match without taking a dependency on daemon
 * internals.
 */

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

// ─── Tool context ────────────────────────────────────────────────────────────

/**
 * Context passed to a plugin-authored tool's `execute` method.
 *
 * This is the **public, narrow** view of the daemon's `ToolContext`. The
 * full internal shape (CES client, trust classification, host-bash proxy,
 * lifecycle event handlers, requester metadata, etc.) lives in
 * `assistant/src/tools/types.ts` and is reserved for daemon-internal
 * tools. Plugin tools receive the same runtime object at execute time —
 * extra fields are simply not part of the public contract.
 *
 * Fields here are the subset stable across daemon revisions:
 *
 * - `conversationId`: the conversation the tool invocation belongs to.
 * - `workingDir`: the directory the daemon was launched from, for
 *   plugins that touch the filesystem outside their `pluginStorageDir`.
 * - `requestId`: per-turn correlation id; surface in plugin logs so
 *   plugin output can be joined with daemon logs.
 * - `signal`: cooperative cancellation. Long-running plugin tools
 *   should check `signal.aborted` (or pass `signal` into `fetch` /
 *   child-process options) and bail with `isError: true` on abort.
 * - `onOutput`: optional incremental-output callback. Streaming plugin
 *   tools should fall back to returning the full result in `content`
 *   when this is absent.
 *
 * Adding fields to this surface is a non-breaking change. Renaming
 * or removing fields is breaking and gated on a major bump of
 * `@vellumai/plugin-api`.
 */
export interface ToolContext {
  /** Identifier of the conversation this tool invocation belongs to. */
  conversationId: string;
  /** Working directory the daemon was launched from. */
  workingDir: string;
  /** Per-turn request id for cross-component log correlation. */
  requestId?: string;
  /** Cooperative cancellation signal for long-running tools. */
  signal?: AbortSignal;
  /** Optional incremental-output callback for streaming tools. */
  onOutput?: (chunk: string) => void;
}

// ─── Tool execution result ───────────────────────────────────────────────────

/**
 * Return shape of a plugin-authored tool's `execute` method.
 *
 * The daemon-side `ToolExecutionResult` (in
 * `assistant/src/tools/types.ts`) carries additional fields that the
 * runtime populates around the call — risk metadata, approval
 * bookkeeping, sensitive-output bindings, etc. Plugins MUST NOT set
 * those: they are runtime-internal and stripped/overwritten by the
 * executor. The shape here exposes the small set of fields plugins
 * are responsible for producing.
 *
 * - `content`: the textual result the LLM sees in the tool-result
 *   block. Empty string is valid.
 * - `isError`: when `true`, the agent loop treats `content` as an
 *   error message and may surface it to the user / retry.
 * - `status`: optional short status string for client display
 *   (e.g. `"truncated"`, `"timed out"`).
 * - `yieldToUser`: when `true`, the agent loop pushes the tool result
 *   onto history and yields control back to the user instead of
 *   running another LLM call. Used by tools that want to force the
 *   loop to stop (e.g. interactive surfaces, `remember`-style "end
 *   my turn" hooks).
 *
 * Adding fields here is a non-breaking change; renaming or removing
 * fields is breaking and gated on a major bump.
 */
export interface ToolExecutionResult {
  /** Textual result shown to the model in the tool-result block. */
  content: string;
  /** When true, the result is surfaced as an error to the agent loop. */
  isError: boolean;
  /** Optional short status message for client display. */
  status?: string;
  /** When true, the agent loop yields back to the user after this result. */
  yieldToUser?: boolean;
}
