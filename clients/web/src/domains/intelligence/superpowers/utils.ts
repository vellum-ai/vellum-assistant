import type { PluginFilter } from "@/domains/intelligence/plugins/types";

import type { SuperpowerFilter } from "./types";

/**
 * Map the shared filter onto the skills query's server-side params.
 * The type filters carry no skill narrowing (`skills` shows everything
 * skill-side; `plugins` disables the skills query entirely).
 */
export function skillParamsForFilter(filter: SuperpowerFilter): {
  origin?: string;
  kind?: "installed" | "available";
} {
  switch (filter) {
    case "installed":
      return { kind: "installed" };
    case "available":
      return { kind: "available" };
    case "vellum":
    case "clawhub":
    case "skillssh":
    case "custom":
    case "assistant-memory":
      return { origin: filter };
    default:
      return {};
  }
}

/** Whether the filter surfaces skill rows at all. */
export function filterShowsSkills(filter: SuperpowerFilter): boolean {
  return filter !== "plugins";
}

/**
 * Whether the filter surfaces plugin rows at all. The skill-origin filters
 * are skills-only, so they hide plugins alongside the `skills` type filter.
 */
export function filterShowsPlugins(filter: SuperpowerFilter): boolean {
  return (
    filter === "all" ||
    filter === "installed" ||
    filter === "available" ||
    filter === "plugins"
  );
}

/** Map the shared filter onto the plugin list's status filter. */
export function pluginFilterFor(filter: SuperpowerFilter): PluginFilter {
  switch (filter) {
    case "installed":
      return "installed";
    case "available":
      return "available";
    default:
      return "all";
  }
}
