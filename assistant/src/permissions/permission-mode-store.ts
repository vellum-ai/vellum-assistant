/**
 * Singleton runtime store for host-access permission state.
 *
 * Reads initial state from the `permissions` section of config.json on
 * initialization and persists mutations back to the config file via the
 * raw-config read/write helpers so env-var-derived keys are never leaked
 * to disk.
 *
 * Downstream consumers register change listeners via `onModeChanged()`.
 */

import {
  invalidateConfigCache,
  loadConfig,
  loadRawConfig,
  saveRawConfig,
} from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import type { PermissionMode } from "./permission-mode.js";
import { DEFAULT_PERMISSION_MODE } from "./permission-mode.js";

const log = getLogger("permission-mode-store");

export type ModeChangeListener = (mode: PermissionMode) => void;

let currentMode: PermissionMode = { ...DEFAULT_PERMISSION_MODE };
let initialized = false;
const listeners: ModeChangeListener[] = [];

function notifyListeners(): void {
  const snapshot = { ...currentMode };
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (err) {
      log.error({ err }, "Error in permission mode change listener");
    }
  }
}

function persistToConfig(): void {
  try {
    const raw = loadRawConfig();
    const existingPermissions =
      raw.permissions != null &&
      typeof raw.permissions === "object" &&
      !Array.isArray(raw.permissions)
        ? (raw.permissions as Record<string, unknown>)
        : {};
    raw.permissions = {
      ...(existingPermissions.mode !== undefined
        ? { mode: existingPermissions.mode }
        : {}),
      hostAccess: currentMode.hostAccess,
    };

    saveRawConfig(raw);
    invalidateConfigCache();
  } catch (err) {
    log.error({ err }, "Failed to persist permission mode to config");
  }
}

export function initPermissionModeStore(): void {
  if (initialized) return;

  try {
    const config = loadConfig();
    currentMode = {
      hostAccess: config.permissions.hostAccess,
    };
  } catch (err) {
    log.warn(
      { err },
      "Failed to load permission mode from config; using defaults",
    );
    currentMode = { ...DEFAULT_PERMISSION_MODE };
  }

  initialized = true;
}

export function getMode(): PermissionMode {
  if (!initialized) {
    initPermissionModeStore();
  }
  return { ...currentMode };
}

export function setHostAccess(value: boolean): void {
  if (!initialized) {
    initPermissionModeStore();
  }

  if (currentMode.hostAccess === value) return;

  currentMode.hostAccess = value;
  persistToConfig();
  notifyListeners();
}

export function onModeChanged(callback: ModeChangeListener): () => void {
  listeners.push(callback);
  return () => {
    const idx = listeners.indexOf(callback);
    if (idx >= 0) {
      listeners.splice(idx, 1);
    }
  };
}

export function resetForTesting(): void {
  currentMode = { ...DEFAULT_PERMISSION_MODE };
  initialized = false;
  listeners.length = 0;
}
