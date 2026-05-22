/**
 * Shapes for the assistant plugins surface.
 *
 * Mirrors the CLI structures in `assistant/src/cli/lib/`:
 *
 *   - `listInstalledPlugins()` (`list-installed-plugins.ts`) → kind=`installed`
 *   - `searchPlugins()`        (`search-plugins.ts`)        → kind=`catalog`
 *
 * The web tab consumes both via a unified envelope so row/list
 * components stay shape-agnostic, mirroring how `SkillInfo` collapses
 * `bundled`/`installed`/`catalog`.
 *
 * The server endpoints these types describe (`/v1/assistants/{id}/plugins/*`)
 * are intentionally added here ahead of the daemon implementation — the
 * UI ships first behind the `external-plugins` flag and lights up when
 * the runtime side lands. See `assistant/src/cli/commands/plugins.ts`
 * for the current CLI surface that the daemon will mirror.
 */

/** Lifecycle bucket. */
export type PluginKind = "installed" | "catalog";

/**
 * A single plugin entry surfaced to the UI. `kind` discriminates between
 * "found under `<workspaceDir>/plugins/`" (installed) and "available in
 * the canonical GitHub source" (catalog). The two halves can be merged
 * in either the server (preferred) or the client (fallback).
 */
export interface PluginInfo {
  /**
   * Stable identifier across kinds. For both `installed` and `catalog`
   * entries this is the plugin's directory name (kebab-case), which
   * matches `assistant plugins install <id>`.
   */
  readonly id: string;
  /** Directory name; equal to `id` for the foreseeable future. */
  readonly name: string;
  /** From `package.json#description`; `null` when unknown. */
  readonly description: string | null;
  /** From `package.json#version`; `null` when unknown. */
  readonly version: string | null;
  readonly kind: PluginKind;
  /**
   * For catalog entries: path within the canonical repo
   * (`experimental/plugins/<name>`). For installed entries: absolute fs
   * path on the assistant host. Optional because the server may choose
   * not to expose absolute paths.
   */
  readonly path?: string;
  /**
   * Non-fatal issues surfaced by the daemon for installed plugins —
   * e.g. `"missing package.json"`, `"package.json invalid JSON"`.
   * Mirrors `InstalledPluginInfo.issues` from the CLI lib.
   */
  readonly issues?: readonly string[];
  /**
   * Optional source repo hint (e.g. `"vellum-ai/vellum-assistant"`) for
   * catalog entries. Allows future hosting outside the canonical repo.
   */
  readonly sourceRepo?: string;
}

/** Response envelope for `GET /v1/assistants/{id}/plugins/`. */
export interface PluginsListResponse {
  readonly plugins: readonly PluginInfo[];
}

/** Body for `POST /v1/assistants/{id}/plugins/install`. */
export interface InstallPluginRequest {
  readonly name: string;
  /** Optional git ref (branch/tag/sha); defaults to canonical ref server-side. */
  readonly ref?: string;
  /** Overwrite an existing install when `true`. Mirrors CLI `--force`. */
  readonly force?: boolean;
}

/** Response envelope for `POST /v1/assistants/{id}/plugins/install`. */
export interface InstallPluginResponse {
  readonly ok: boolean;
  /** The installed plugin's id (i.e. its directory name). */
  readonly pluginId?: string;
}

/** Filter values surfaced in the tab's filter bar. */
export type PluginFilter = "all" | "installed" | "available";

export function isInstalledPlugin(plugin: PluginInfo): boolean {
  return plugin.kind === "installed";
}

export function isAvailablePlugin(plugin: PluginInfo): boolean {
  return plugin.kind === "catalog";
}
