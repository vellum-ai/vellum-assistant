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

export const addDesktopFilesLauncherMigration: WorkspaceMigration = {
  id: "157-add-desktop-files-launcher",
  description: "Add Files to existing virtual desktop docks",
  retryFailedCheckpoint: true,
  run(workspaceDir): void {
    const configDir = join(workspaceDir, "data", "desktop-panel");
    const settingsPath = join(configDir, "glib-2.0", "settings", "keyfile");
    let settings: string;
    try {
      settings = readFileSync(settingsPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }

    const section =
      /(?:^|\n)\[net\/launchpad\/plank\/docks\/dock1\]\r?\n([^]*?)(?=\n\[|$)/;
    const match = settings.match(section);
    if (!match) {
      return;
    }
    const pins = /^(dock-items\s*=\s*)(?:@as\s+)?\[([^\r\n]*)\](\r?)$/m;
    const existing = match[1]!.match(pins);
    if (existing && !existing[2]!.includes("'files.dockitem'")) {
      const items = existing[2]!.trim();
      let updatedItems: string;
      if (items.includes("'chrome.dockitem'")) {
        updatedItems = items.replace(
          "'chrome.dockitem'",
          "'chrome.dockitem', 'files.dockitem'",
        );
      } else if (items.includes("'terminal.dockitem'")) {
        updatedItems = items.replace(
          "'terminal.dockitem'",
          "'files.dockitem', 'terminal.dockitem'",
        );
      } else {
        updatedItems = `${items}${items ? ", " : ""}'files.dockitem'`;
      }
      const updated = match[0].replace(
        pins,
        () => `${existing[1]}[${updatedItems}]${existing[3]}`,
      );
      settings = settings.replace(section, () => updated);
    } else if (!existing) {
      settings = settings.replace(
        section,
        () =>
          `${match[0]}${match[0].endsWith("\n") ? "" : "\n"}dock-items=['files.dockitem']\n`,
      );
    }

    const launchersDir = join(configDir, "plank", "dock1", "launchers");
    mkdirSync(launchersDir, { recursive: true });
    const launcher = pathToFileURL(
      join(configDir, "applications", "thunar.desktop"),
    ).href;
    const pinPath = join(launchersDir, "files.dockitem");
    const pinTemporaryPath = `${pinPath}.migration.tmp`;
    try {
      writeFileSync(
        pinTemporaryPath,
        `[PlankDockItemPreferences]\nLauncher=${launcher}\n`,
        { flush: true },
      );
      linkSync(pinTemporaryPath, pinPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    } finally {
      rmSync(pinTemporaryPath, { force: true });
    }
    const temporaryPath = `${settingsPath}.files-migration.tmp`;
    writeFileSync(temporaryPath, settings, { flush: true });
    renameSync(temporaryPath, settingsPath);
  },
  down(): void {},
};
