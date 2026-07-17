import type {
  InstalledPlugin,
  PluginCatalogMatch,
  PluginFilter,
  PluginListItem,
} from "./types";

/**
 * Consolidate the installed list and the catalog into one row model.
 * Catalog entries whose name is already installed are dropped — the two
 * endpoints are independent, so a locally-installed plugin still appears in
 * the catalog, and suppressing it keeps the "available" set honest.
 */
export function mergePlugins(
  installed: readonly InstalledPlugin[],
  catalog: readonly PluginCatalogMatch[],
): PluginListItem[] {
  const installedItems: PluginListItem[] = installed.map((p) => ({
    name: p.name,
    description: p.description ?? undefined,
    status: "installed",
    // Origin is unknown for installed plugins: the list endpoint has no
    // `source`. Leave `external` undefined so the detail header shows a
    // neutral placeholder until `pluginsByNameGet` resolves the real origin,
    // rather than asserting "local" and flipping to "external" on load.
    external: undefined,
    version: p.version ?? undefined,
    path: p.path,
    issues: p.issues,
    // Installed rows carry enablement; older daemons omit it (undefined).
    enabled: p.enabled,
    icon: p.icon,
    // Bundled-icon signals; absent on the catalog and on pre-icon daemons.
    hasIcon: p.hasIcon,
    iconVersion: p.iconVersion,
  }));

  const installedNames = new Set(installedItems.map((i) => i.name));

  const catalogItems: PluginListItem[] = catalog
    .filter((m) => !installedNames.has(m.name))
    .map((m) => ({
      name: m.name,
      description: m.description,
      status: "available",
      external: true,
      path: m.path,
    }));

  return [...installedItems, ...catalogItems];
}

/** Case-insensitive substring match against a plugin's name + description. */
export function matchesQuery(item: PluginListItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.name, item.description].some((f) =>
    f?.toLowerCase().includes(q),
  );
}

/** Installed first, then alphabetical by name. Mirrors `sortSkills`. */
export function sortPlugins(items: PluginListItem[]): PluginListItem[] {
  return [...items].sort((a, b) => {
    const aInstalled = a.status === "installed";
    const bInstalled = b.status === "installed";
    if (aInstalled !== bInstalled) return aInstalled ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export function filterByStatus(
  items: PluginListItem[],
  filter: PluginFilter,
): PluginListItem[] {
  switch (filter) {
    case "all":
      return items;
    case "available":
      return items.filter((i) => i.status === "available");
    // Every installed plugin, regardless of enablement — offered instead of
    // Active/Off on daemons that predate enable/disable.
    case "installed":
      return items.filter((i) => i.status === "installed");
    // Active = installed & enabled. Enablement `undefined` (older daemons) is
    // treated as active, so a plugin never silently disappears when the daemon
    // predates enable/disable.
    case "active":
      return items.filter(
        (i) => i.status === "installed" && i.enabled !== false,
      );
    // Off = installed & explicitly disabled.
    case "off":
      return items.filter(
        (i) => i.status === "installed" && i.enabled === false,
      );
  }
}

/** First 7 chars of a commit SHA, matching git's default short form. */
export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "unknown";
}
