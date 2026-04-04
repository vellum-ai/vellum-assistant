/**
 * Singleton runtime store for the two-axis permission mode.
 *
 * Reads initial state from the `permissions` section of config.json on
 * initialization and persists mutations back to the config file via the
 * raw-config read/write helpers so env-var–derived keys are never leaked
 * to disk.
 *
 * Downstream consumers (e.g. SSE broadcast) register change listeners
 * via `onModeChanged()`.
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModeChangeListener = (mode: PermissionMode) => void;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let currentMode: PermissionMode = { ...DEFAULT_PERMISSION_MODE };
let initialized = false;
const listeners: ModeChangeListener[] = [];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

/**
 * Persist the current in-memory permission mode to config.json.
 *
 * Uses the raw-config pattern (loadRawConfig → mutate → saveRawConfig) so
 * that env-var–derived fields (API keys, dataDir) are never written to disk.
 */
function persistToConfig(): void {
  try {
    const raw = loadRawConfig();

    // Ensure the permissions object exists
    if (
      raw.permissions == null ||
      typeof raw.permissions !== "object" ||
      Array.isArray(raw.permissions)
    ) {
      raw.permissions = {};
    }

    const permissions = raw.permissions as Record<string, unknown>;
    permissions.askBeforeActing = currentMode.askBeforeActing;
    permissions.hostAccess = currentMode.hostAccess;

    saveRawConfig(raw);

    // Invalidate the cached config so the next loadConfig() picks up the
    // persisted values rather than returning stale in-memory state.
    invalidateConfigCache();
  } catch (err) {
    log.error({ err }, "Failed to persist permission mode to config");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the store from the current config. Safe to call multiple times;
 * subsequent calls are no-ops unless `resetForTesting()` has been called.
 */
export function initPermissionModeStore(): void {
  if (initialized) return;

  try {
    const config = loadConfig();
    currentMode = {
      askBeforeActing: config.permissions.askBeforeActing,
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

/**
 * Return the current permission mode. Initializes from config on first call
 * if `initPermissionModeStore()` hasn't been called yet.
 */
export function getMode(): PermissionMode {
  if (!initialized) {
    initPermissionModeStore();
  }
  return { ...currentMode };
}

/**
 * Update the `askBeforeActing` axis. Persists to config.json and notifies
 * change listeners.
 */
export function setAskBeforeActing(value: boolean): void {
  if (!initialized) {
    initPermissionModeStore();
  }

  if (currentMode.askBeforeActing === value) return;

  currentMode.askBeforeActing = value;
  persistToConfig();
  notifyListeners();
}

/**
 * Update the `hostAccess` axis. Persists to config.json and notifies
 * change listeners.
 */
export function setHostAccess(value: boolean): void {
  if (!initialized) {
    initPermissionModeStore();
  }

  if (currentMode.hostAccess === value) return;

  currentMode.hostAccess = value;
  persistToConfig();
  notifyListeners();
}

/**
 * Register a callback that fires whenever the permission mode changes.
 * Returns an unsubscribe function.
 */
export function onModeChanged(callback: ModeChangeListener): () => void {
  listeners.push(callback);
  return () => {
    const idx = listeners.indexOf(callback);
    if (idx >= 0) {
      listeners.splice(idx, 1);
    }
  };
}

/**
 * Reset the store to uninitialized state. **Test-only** — production code
 * should never call this.
 */
export function resetForTesting(): void {
  currentMode = { ...DEFAULT_PERMISSION_MODE };
  initialized = false;
  listeners.length = 0;
}
