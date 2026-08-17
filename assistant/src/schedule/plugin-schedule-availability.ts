/**
 * Availability probe for a plugin-declared schedule's source.
 *
 * Composes the daemon's activation state with the on-disk declaration probe,
 * so arming, firing, run-now, and re-enable all answer the same question: did
 * this process bring the plugin up, and is its declaration still sourceable.
 *
 * The composition lives here rather than in `./plugin-schedule-declarations.ts`
 * because that parser is reachable from the plugin loader's own static graph
 * and must stay free of daemon runtime state. `plugins/mtime-cache.ts` reaches
 * the schedule side only through a dynamic import, so importing it here does
 * not close a static cycle.
 */

import { join } from "node:path";

import { isPluginDirActivated } from "../plugins/mtime-cache.js";
import { getWorkspacePluginsDir } from "../util/platform.js";
import { declarationExistsOnDisk } from "./plugin-schedule-declarations.js";

/**
 * True when the schedule behind `sourceKey`
 * (`plugin:<pluginName>/<scheduleName>`) may run: the daemon activated the
 * plugin, and {@link declarationExistsOnDisk} still finds the declaration.
 *
 * The activation half is what keeps a plugin directory dropped into the
 * plugins root out of the scheduler. Such a directory has files the disk probe
 * accepts, but no `init` has run for it, so its hooks and tools are not live
 * and its schedules must not be either.
 */
export async function pluginScheduleSourceAvailable(
  sourceKey: string,
): Promise<boolean> {
  const match = /^plugin:([^/]+)\/(.+)$/.exec(sourceKey);
  if (!match) {
    return false;
  }
  const [, pluginName] = match;
  const pluginDir = join(getWorkspacePluginsDir(), pluginName!);
  return (
    isPluginDirActivated(pluginDir) &&
    (await declarationExistsOnDisk(sourceKey))
  );
}
