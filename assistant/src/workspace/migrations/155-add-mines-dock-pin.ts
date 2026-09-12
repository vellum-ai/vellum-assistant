import { randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { WorkspaceMigration } from "./types.js";

export const addMinesDockPinMigration: WorkspaceMigration = {
  id: "155-add-mines-dock-pin",
  description: "Add Mines to existing desktop docks",
  retryFailedCheckpoint: true,
  run(workspaceDir: string): void {
    const panelDir = join(workspaceDir, "data", "desktop-panel");
    const settingsPath = join(panelDir, "glib-2.0", "settings", "keyfile");
    let settings: string;
    try {
      settings = readFileSync(settingsPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }

    const lines = settings.split("\n");
    let inDock = false;
    const itemsIndex = lines.findIndex((line) => {
      if (line.startsWith("[")) {
        inDock = line.trim() === "[net/launchpad/plank/docks/dock1]";
      }
      return inDock && line.startsWith("dock-items=");
    });
    if (itemsIndex === -1) {
      return;
    }
    const items = lines[itemsIndex];
    if (!/['"]mines\.dockitem['"]/.test(items)) {
      lines[itemsIndex] = items.replace(
        /\]\s*$/,
        `${/\[\s*\]/.test(items) ? "" : ", "}'mines.dockitem']`,
      );
    }

    const launchersDir = join(panelDir, "plank", "dock1", "launchers");
    mkdirSync(launchersDir, { recursive: true });
    const launcher = pathToFileURL(
      join(panelDir, "applications", "org.gnome.Mines.desktop"),
    ).href;
    const pinPath = join(launchersDir, "mines.dockitem");
    const temporaryPath = `${pinPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporaryPath,
        `[PlankDockItemPreferences]\nLauncher=${launcher}\n`,
        { flush: true },
      );
      linkSync(temporaryPath, pinPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    } finally {
      rmSync(temporaryPath, { force: true });
    }
    const updated = lines.join("\n");
    if (updated !== settings) {
      writeFileSync(settingsPath + ".tmp", updated);
      renameSync(settingsPath + ".tmp", settingsPath);
    }
  },
  down(): void {
    // Keep user dock pins when rolling back.
  },
};
