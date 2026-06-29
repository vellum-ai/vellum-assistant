import type {
  PluginsGetResponse,
  PluginsSearchGetResponse,
} from "@/generated/daemon/types.gen";

export type PluginStatus = "installed" | "available";

export type PluginFilter = "all" | "installed" | "available";

/**
 * Unified row model for the Plugins tab, populated from two independent
 * daemon endpoints: the installed list (`pluginsGet`) and the catalog
 * (`pluginsSearchGet`). Mirrors the Skills domain's `SkillInfo`.
 */
export interface PluginListItem {
  name: string;
  description?: string;
  status: PluginStatus;
  external: boolean;
  version?: string;
  path?: string;
  sourceHost?: string;
  issues?: string[];
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
}

interface CatalogPluginSource {
  name: string;
  description?: string;
  path: string;
  source: { repo: string };
}

type _InstalledCompat = AssertAssignable<InstalledPluginSource, InstalledPlugin>;
type _CatalogCompat = AssertAssignable<CatalogPluginSource, PluginCatalogMatch>;
