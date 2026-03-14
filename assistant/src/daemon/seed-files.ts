import { existsSync, mkdirSync } from "node:fs";

import { getLogger } from "../util/logger.js";
import { getInterfacesDir } from "../util/platform.js";

const log = getLogger("seed-files");

/**
 * Ensures interface directories exist so the runtime can serve files
 * immediately. Called during daemon startup.
 */
export function seedInterfaceFiles(): void {
  const tuiDir = getInterfacesDir();
  if (!existsSync(tuiDir)) {
    mkdirSync(tuiDir, { recursive: true });
    log.info("Created interfaces directory");
  }
}
