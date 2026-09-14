import { rmSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

export const migrateDesktopDockMigration: WorkspaceMigration = {
  id: "154-migrate-desktop-dock",
  description:
    "Remove generated tint2 files before desktop dock initialization",
  run(workspaceDir: string): void {
    const panelDir = join(workspaceDir, "data", "desktop-panel");
    for (const name of [
      "tint2rc",
      "browser.png",
      "chromium.desktop",
      "terminal.desktop",
    ]) {
      rmSync(join(panelDir, name), { force: true });
    }
  },
  down(): void {
    // Managed dock files are regenerated at desktop start.
  },
};
