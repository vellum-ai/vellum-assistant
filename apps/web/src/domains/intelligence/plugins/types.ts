/**
 * Shapes for the assistant plugins surface.
 *
 * Mirrors the CLI structure in
 * `assistant/src/cli/lib/list-installed-plugins.ts` — the web tab
 * currently surfaces installed plugins only. Catalog / install /
 * uninstall affordances are deferred to follow-up work; this module
 * intentionally stays narrow to keep the contract small while the
 * daemon-side endpoint is still being designed.
 */

/**
 * A single installed plugin surfaced to the UI. Field set tracks
 * `InstalledPluginInfo` from the CLI lib so the daemon endpoint can
 * project directly without re-deriving anything.
 */
export interface PluginInfo {
  /**
   * Plugin's directory name (kebab-case). Matches
   * `assistant plugins install <id>`.
   */
  readonly id: string;
  /** Directory name; equal to `id`. */
  readonly name: string;
  /** From `package.json#description`; `null` when unknown. */
  readonly description: string | null;
  /** From `package.json#version`; `null` when unknown. */
  readonly version: string | null;
  /**
   * Absolute fs path on the assistant host. Optional because the
   * server may choose not to expose absolute paths.
   */
  readonly path?: string;
  /**
   * Non-fatal issues surfaced by the daemon for installed plugins —
   * e.g. `"missing package.json"`, `"package.json invalid JSON"`.
   * Mirrors `InstalledPluginInfo.issues` from the CLI lib.
   */
  readonly issues?: readonly string[];
}

/** Response envelope for `GET /v1/assistants/{id}/plugins/`. */
export interface PluginsListResponse {
  readonly plugins: readonly PluginInfo[];
}
