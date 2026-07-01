import type {
  PluginsGetResponse,
  PluginsSearchGetResponse,
} from "@/generated/daemon/types.gen";

export type PluginStatus = "installed" | "available";

/**
 * User-facing status filter. Orthogonal to `PluginStatus`: `active` and `off`
 * both narrow the installed set by enablement (Active = installed & enabled,
 * Off = installed & !enabled), while `available` is the not-installed catalog.
 */
export type PluginFilter = "all" | "active" | "off" | "available";

/**
 * Unified row model for the Plugins tab, populated from two independent
 * daemon endpoints: the installed list (`pluginsGet`) and the catalog
 * (`pluginsSearchGet`). Mirrors the Skills domain's `SkillInfo`.
 */
export interface PluginListItem {
  name: string;
  description?: string;
  status: PluginStatus;
  /**
   * Whether the plugin comes from an external (GitHub) source. `undefined`
   * when origin is unknown — the installed-list endpoint carries no `source`,
   * so an installed plugin's origin isn't known until its detail loads.
   */
  external?: boolean;
  version?: string;
  path?: string;
  issues?: string[];
  /**
   * Whether the plugin is active in this workspace. Installed rows only —
   * catalog/available rows carry no enablement. `undefined` on daemons that
   * predate the enable/disable surface (version-skew safeguard).
   */
  enabled?: boolean;
}

/** Generated element type for an installed plugin (`pluginsGet`). */
export type InstalledPlugin = PluginsGetResponse["plugins"][number];

/** Generated element type for a catalog match (`pluginsSearchGet`). */
export type PluginCatalogMatch = PluginsSearchGetResponse["matches"][number];

/**
 * Compile-time guard: the generated response element types must keep the
 * source fields `mergePlugins` reads, with compatible shapes. If the daemon
 * OpenAPI spec renames a field, these lines produce a type error — surfacing
 * the drift immediately instead of silently at runtime.
 *
 * @see ./utils.ts (mergePlugins)
 */
type AssertAssignable<_Target, _Source extends _Target> = true;

interface InstalledPluginSource {
  name: string;
  description: string | null;
  version: string | null;
  path?: string;
  issues?: string[];
  enabled?: boolean;
}

interface CatalogPluginSource {
  name: string;
  description?: string;
  path: string;
  source: { repo: string };
}

type _InstalledCompat = AssertAssignable<InstalledPluginSource, InstalledPlugin>;
type _CatalogCompat = AssertAssignable<CatalogPluginSource, PluginCatalogMatch>;
