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
 * Today this module is intentionally narrow — only `PluginInitContext` and
 * `PluginShutdownContext`. Additional public types migrate over in
 * follow-up PRs as the surface stabilizes.
 *
 * Internal-only types (pipeline shapes, middleware, manifest validation,
 * etc.) stay in `assistant/src/plugins/types.ts` until they're ready to
 * become public.
 */

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
  /**
   * Pino-compatible child logger bound to `{ plugin: <name> }`. Untyped here
   * to avoid pulling pino into the types module.
   */
  logger: unknown;
  /** Absolute path to `<workspaceDir>/plugins-data/<plugin>/` (created by bootstrap). */
  pluginStorageDir: string;
  /** Assistant semver for compatibility checks inside the plugin. */
  assistantVersion: string;
  /** Capability → version-list map (`ASSISTANT_API_VERSIONS`) for defensive runtime checks. */
  apiVersions: Record<string, string[]>;
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
