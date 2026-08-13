/**
 * Typed view over the plugin's `config.json` (`InitContext.config`).
 * Unknown or malformed input falls back to defaults so a bad user edit
 * degrades the plugin instead of aborting its load.
 *
 * `init` seeds the parsed config for the main daemon process. Hooks can
 * also be dispatched in processes that never run the plugin lifecycle
 * (sidecar workers waking a conversation), and route modules get a fresh
 * module instance; for those, {@link getActiveConfig} lazily reads
 * `config.json` from the installed plugin's directory, mirroring the
 * tally store's lazy open.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceDir } from "@vellumai/plugin-api";

import { PLUGIN_NAME } from "./tally-store.js";

export interface TurnTallyConfig {
  /** When true, `post-tool-use` also keeps per-tool-name counts. */
  trackToolNames: boolean;
}

export const DEFAULT_CONFIG: TurnTallyConfig = { trackToolNames: true };

let activeConfig: TurnTallyConfig | null = null;

export function parseConfig(raw: unknown): TurnTallyConfig {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_CONFIG;
  }
  const candidate = (raw as { trackToolNames?: unknown }).trackToolNames;
  return {
    trackToolNames:
      typeof candidate === "boolean"
        ? candidate
        : DEFAULT_CONFIG.trackToolNames,
  };
}

/** Fallback for processes where `init` has not run: read the user's edit from disk. */
function loadConfigFromDisk(): TurnTallyConfig {
  try {
    const raw = readFileSync(
      join(getWorkspaceDir(), "plugins", PLUGIN_NAME, "config.json"),
      "utf8",
    );
    return parseConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Set by `init` so per-turn hooks read the parsed config without re-parsing. */
export function setActiveConfig(config: TurnTallyConfig): void {
  activeConfig = config;
}

export function getActiveConfig(): TurnTallyConfig {
  if (activeConfig === null) {
    activeConfig = loadConfigFromDisk();
  }
  return activeConfig;
}
