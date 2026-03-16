import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { pathExists } from "../util/fs.js";
import { getLogger } from "../util/logger.js";
import { getHooksDir } from "../util/platform.js";
import { loadHooksConfig } from "./config.js";
import type { DiscoveredHook, HookManifest } from "./types.js";

const log = getLogger("hooks-discovery");

const VALID_EVENTS = new Set<string>([
  "daemon-start",
  "daemon-stop",
  "conversation-start",
  "conversation-end",
  // Legacy aliases — existing user hooks may still reference the old names.
  "session-start",
  "session-end",
  "pre-llm-call",
  "post-llm-call",
  "pre-tool-execute",
  "post-tool-execute",
  "permission-request",
  "permission-resolve",
  "pre-message",
  "post-message",
  "on-error",
]);

/**
 * Validates the core manifest fields required for discovery.
 * `description` and `version` are optional here so that legacy hook manifests
 * (created before those fields were added) continue to be discovered.
 */
export function isValidManifest(manifest: unknown): manifest is HookManifest {
  if (typeof manifest !== "object" || manifest == null) return false;
  const m = manifest as Record<string, unknown>;
  if (typeof m.name !== "string" || !m.name) return false;
  if (typeof m.script !== "string" || !m.script) return false;
  if (!Array.isArray(m.events) || m.events.length === 0) return false;
  for (const e of m.events) {
    if (typeof e !== "string" || !VALID_EVENTS.has(e)) return false;
  }
  // Optional fields: allow if present but must be strings
  if (m.description !== undefined && typeof m.description !== "string")
    return false;
  if (m.version !== undefined && typeof m.version !== "string") return false;
  return true;
}

/**
 * Stricter validation for installing new hooks.
 * Requires `description` and `version` in addition to the core fields.
 */
export function isValidInstallManifest(
  manifest: unknown,
): manifest is HookManifest & { description: string; version: string } {
  if (!isValidManifest(manifest)) return false;
  if (typeof manifest.description !== "string" || !manifest.description)
    return false;
  if (typeof manifest.version !== "string" || !manifest.version) return false;
  return true;
}

export function discoverHooks(hooksDir?: string): DiscoveredHook[] {
  const dir = hooksDir ?? getHooksDir();
  if (!pathExists(dir)) return [];

  const config = loadHooksConfig();
  const hooks: DiscoveredHook[] = [];

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch (err) {
    log.warn({ err, dir }, "Failed to read hooks directory");
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const hookDir = join(dir, entry.name);
    const manifestPath = join(hookDir, "hook.json");
    if (!pathExists(manifestPath)) continue;

    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch (err) {
      log.warn({ err, hookDir }, "Failed to parse hook manifest");
      continue;
    }

    if (!isValidManifest(manifest)) {
      log.warn({ hookDir }, "Invalid hook manifest, skipping");
      continue;
    }

    const scriptPath = resolve(hookDir, manifest.script);
    const rel = relative(hookDir, scriptPath);
    // Normalize backslashes so Windows-style traversal (e.g. `..\\..\\evil.js`) is
    // also caught. This project targets macOS, but we check for defense in depth.
    const normalizedRel = rel.replaceAll("\\", "/");
    if (
      normalizedRel.startsWith("../") ||
      normalizedRel === ".." ||
      resolve(hookDir, rel) !== scriptPath
    ) {
      log.warn(
        { hookDir, script: manifest.script },
        "Hook script path traversal detected, skipping",
      );
      continue;
    }
    if (!pathExists(scriptPath)) {
      log.warn(
        { hookDir, script: manifest.script },
        "Hook script not found, skipping",
      );
      continue;
    }

    hooks.push({
      name: entry.name,
      dir: hookDir,
      manifest,
      scriptPath,
      enabled: config.hooks[entry.name]?.enabled ?? false,
    });
  }

  return hooks.sort((a, b) => a.name.localeCompare(b.name));
}
