import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getInterfacesDir } from "../util/platform.js";

const log = getLogger("seed-files");

/**
 * Seeds interface files (TUI main-window) from their source packages when they
 * don't already exist on disk. Called during daemon startup so the runtime can
 * serve these files immediately.
 */
export function seedInterfaceFiles(): void {
  // Seed the TUI main-window interface from the CLI package's DefaultMainScreen
  // component so the remote runtime can serve it without the old INTERFACES_SEED
  // environment variable.
  const tuiDir = join(getInterfacesDir(), "tui");
  const mainWindowPath = join(tuiDir, "main-window.tsx");
  if (!existsSync(mainWindowPath)) {
    try {
      const require = createRequire(import.meta.url);
      const cliPkgPath = require.resolve("@vellumai/cli/package.json");
      const cliRoot = dirname(cliPkgPath);
      const source = readFileSync(
        join(cliRoot, "src", "components", "DefaultMainScreen.tsx"),
        "utf-8",
      );
      mkdirSync(tuiDir, { recursive: true });
      writeFileSync(mainWindowPath, source);
      log.info("Seeded tui/main-window.tsx from @vellumai/cli");
    } catch (err) {
      log.warn({ err }, "Could not seed tui/main-window.tsx from CLI package");
    }
  }
}
