/**
 * Read the subset of a plugin's hook/tool surfaces that are actually live in
 * the daemon's in-memory registries.
 *
 * `plugins inspect`'s on-disk surface walk (`cli/lib/plugin-surfaces.ts`)
 * reports what a plugin *ships*; this reports what the running daemon actually
 * *loaded*. The two can diverge: a hook or tool file that failed to load is on
 * disk but never registered, and a tool that renames itself via an exported
 * `name` registers under a name the filename walk cannot predict. The registries
 * are authoritative for the live runtime, so this reads them directly:
 *
 * - hooks  → the keys of the plugin's `hooks` record in the plugin registry.
 * - tools  → every tool in the tool registry whose recorded owner is this
 *            plugin (`{ kind: "plugin", id: name }`).
 *
 * This module lives in daemon-land (it imports the registries) and is consumed
 * by the plugin routes; the CLI reaches the same data over IPC rather than
 * importing the registries, which it is forbidden from doing.
 */

import type { RegisteredPluginSurfaces } from "../cli/lib/plugin-surfaces.js";
import { getRegisteredPlugin } from "../plugins/registry.js";
import { getAllTools, getToolOwner } from "../tools/registry.js";

/**
 * Snapshot the live registered hooks and tools for the plugin installed under
 * `name`. Both lists are sorted for a deterministic listing. A plugin that is
 * not currently registered (e.g. it failed to load, or is installed on disk but
 * was never booted) yields empty arrays — never `null`; the in-process daemon
 * is always an authoritative answer, so "unknown" is reserved for callers that
 * could not reach the daemon at all.
 */
export function readRegisteredPluginSurfaces(
  name: string,
): RegisteredPluginSurfaces {
  const plugin = getRegisteredPlugin(name);
  const hooks = plugin?.hooks ? Object.keys(plugin.hooks).sort() : [];
  const tools = getAllTools()
    .map((tool) => tool.name)
    .filter((toolName) => {
      const owner = getToolOwner(toolName);
      return owner?.kind === "plugin" && owner.id === name;
    })
    .sort();
  return { hooks, tools };
}
