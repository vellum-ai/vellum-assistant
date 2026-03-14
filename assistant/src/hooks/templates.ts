import {
  chmodSync,
  cpSync,
  type Dirent,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import { resolveBundledDir } from "../util/bundled-asset.js";
import { pathExists } from "../util/fs.js";
import { getLogger } from "../util/logger.js";
import { getHooksDir } from "../util/platform.js";
import { ensureHookInConfig } from "./config.js";

const log = getLogger("hooks-templates");

/**
 * Install bundled hook templates into the user's hooks directory.
 * Templates are copied from `assistant/hook-templates/` to `~/.vellum/hooks/`.
 * - Never overwrites existing hooks (user modifications are preserved).
 * - Newly installed hooks are disabled by default.
 */
export function installTemplates(): void {
  const templatesDir = resolveBundledDir(
    import.meta.dirname ?? __dirname,
    "../../hook-templates",
    "hook-templates",
  );
  if (!pathExists(templatesDir)) return;

  const hooksDir = getHooksDir();
  const entries = readdirSync(templatesDir, {
    withFileTypes: true,
  }) as Dirent[];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const targetDir = join(hooksDir, entry.name);
    if (pathExists(targetDir)) continue; // Never overwrite user hooks

    try {
      // Copy template directory
      cpSync(join(templatesDir, entry.name), targetDir, { recursive: true });

      // Make script executable
      const manifestPath = join(targetDir, "hook.json");
      if (pathExists(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        if (manifest.script) {
          chmodSync(join(targetDir, manifest.script), 0o755);
        }
      }

      // Add to config (disabled by default)
      ensureHookInConfig(entry.name, { enabled: false });

      log.info(
        { hook: entry.name },
        "Installed hook template (disabled by default)",
      );
    } catch (err) {
      // Clean up partially-copied directory so the next restart can retry
      try {
        rmSync(targetDir, { recursive: true, force: true });
      } catch (e) {
        log.debug(
          { err: e },
          "Cleanup of partial hook template directory failed",
        );
      }
      log.warn({ err, hook: entry.name }, "Failed to install hook template");
    }
  }
}
