import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("plugin-storage");
const PLUGIN_DATA_DIRNAME = "data";

function ensureLegacyStorageDir(pluginId: string): string {
  const dir = join(getWorkspaceDir(), "plugins-data", pluginId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve and create the durable storage directory for one plugin owner. */
export function resolvePluginStorageDir(
  pluginId: string,
  pluginDir: string | null,
): string {
  if (pluginDir === null) {
    return ensureLegacyStorageDir(pluginId);
  }

  const dataDir = join(pluginDir, PLUGIN_DATA_DIRNAME);
  if (!existsSync(dataDir)) {
    const oldDir = join(getWorkspaceDir(), "plugins-data", pluginId);
    if (existsSync(oldDir)) {
      try {
        mkdirSync(dataDir, { recursive: true });
        cpSync(oldDir, dataDir, { recursive: true });
        rmSync(oldDir, { recursive: true, force: true });
        log.info(
          { plugin: pluginId, oldDir, dataDir },
          "migrated plugin data from plugins-data to plugin directory",
        );
      } catch (err) {
        log.warn(
          { err, plugin: pluginId, oldDir, dataDir },
          "failed to migrate plugin data to plugin directory, using old location",
        );
        return ensureLegacyStorageDir(pluginId);
      }
    }
  }

  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}
