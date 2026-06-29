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
    external: false,
    version: p.version ?? undefined,
    path: p.path,
    issues: p.issues,
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
  if (filter === "all") return items;
  return items.filter((i) => i.status === filter);
}

/** First 7 chars of a commit SHA, matching git's default short form. */
export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "unknown";
}
