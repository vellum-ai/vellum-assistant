import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { isPlainObject } from "../util/object.js";
import { migrationLog } from "./log.js";

/**
 * Merge missing hook entries from a legacy hooks/config.json into the
 * workspace hooks/config.json. Only adds hooks that don't already exist
 * in the workspace config so user changes are never overwritten.
 */
export function mergeHooksConfig(
  legacyPath: string,
  workspacePath: string,
): void {
  let legacy: Record<string, unknown>;
  let workspace: Record<string, unknown>;
  try {
    const legacyRaw = JSON.parse(readFileSync(legacyPath, "utf-8"));
    const workspaceRaw = JSON.parse(readFileSync(workspacePath, "utf-8"));
    if (!isPlainObject(legacyRaw) || !isPlainObject(workspaceRaw)) return;
    legacy = legacyRaw;
    workspace = workspaceRaw;
  } catch {
    return;
  }

  const legacyHooks = legacy.hooks;
  const wsHooks = workspace.hooks;
  if (!isPlainObject(legacyHooks) || !isPlainObject(wsHooks)) return;

  const merged: string[] = [];
  for (const hookName of Object.keys(legacyHooks)) {
    if (!(hookName in wsHooks)) {
      wsHooks[hookName] = legacyHooks[hookName];
      merged.push(hookName);
    }
  }

  if (merged.length > 0) {
    try {
      writeFileSync(workspacePath, JSON.stringify(workspace, null, 2) + "\n");
      // Remove merged hooks from legacy config to prevent resurrection
      for (const hookName of merged) {
        delete legacyHooks[hookName];
      }
      if (Object.keys(legacyHooks).length === 0) {
        unlinkSync(legacyPath);
      } else {
        writeFileSync(legacyPath, JSON.stringify(legacy, null, 2) + "\n");
      }
      migrationLog(
        "info",
        "Merged legacy hooks config entries into workspace",
        { hooks: merged },
      );
    } catch (err) {
      migrationLog("warn", "Failed to merge legacy hooks config", {
        err: String(err),
        hooks: merged,
      });
    }
  }
}

/**
 * When migratePath skips the hooks directory because the workspace copy
 * already exists (e.g. pre-created by ensureDataDir), the legacy hooks
 * directory may still contain individual hook files/subdirectories that
 * were never moved. This merges any missing entries from the legacy
 * path into the workspace hooks path so they are not silently lost.
 */
export function mergeLegacyHooks(
  legacyDir: string,
  workspaceDir: string,
): void {
  if (!existsSync(legacyDir) || !existsSync(workspaceDir)) return;

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(legacyDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const src = join(legacyDir, entry.name);
    const dest = join(workspaceDir, entry.name);
    if (existsSync(dest)) {
      // config.json needs a merge rather than a skip — the legacy file may
      // contain hook enabled/settings entries that the workspace copy lacks.
      if (entry.name === "config.json") {
        mergeHooksConfig(src, dest);
      }
      continue;
    }
    try {
      renameSync(src, dest);
      migrationLog("info", "Merged legacy hook into workspace", {
        from: src,
        to: dest,
      });
    } catch (err) {
      migrationLog("warn", "Failed to merge legacy hook", {
        err: String(err),
        from: src,
        to: dest,
      });
    }
  }
}
