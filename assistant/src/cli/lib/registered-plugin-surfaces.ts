/**
 * CLI-side reader for a plugin's live registered surfaces.
 *
 * `plugins inspect` runs locally (disk walk + marketplace fetch) so it keeps
 * working when the daemon is down. The "which hooks/tools are actually
 * registered" question, however, can only be answered by the running daemon —
 * the registries live in its memory. This bridges that gap over IPC: it calls
 * the daemon's `plugins_surfaces` route and adapts the result into the shape
 * `inspectPlugin` expects for {@link PluginSurfaces.registered}.
 *
 * Best-effort by contract: any failure (daemon not running, route error,
 * timeout) resolves to `null` — "unknown", not an error — so the surrounding
 * inspection still renders its offline-derived data.
 */

import { cliIpcCall } from "../../ipc/cli-client.js";
import type { RegisteredPluginSurfaces } from "./plugin-surfaces.js";

/**
 * Fetch the daemon's live registered hooks/tools for the plugin installed under
 * `name`, or `null` when the daemon could not be consulted. Suitable to pass
 * directly as `inspectPlugin`'s `readRegisteredSurfaces` dependency.
 */
export async function fetchRegisteredPluginSurfaces(
  name: string,
): Promise<RegisteredPluginSurfaces | null> {
  const res = await cliIpcCall<RegisteredPluginSurfaces>("plugins_surfaces", {
    pathParams: { name },
  });
  if (!res.ok || !res.result) return null;
  // Defend against a malformed payload: only adopt arrays, else report unknown.
  const { hooks, tools } = res.result;
  if (!Array.isArray(hooks) || !Array.isArray(tools)) return null;
  return { hooks, tools };
}
