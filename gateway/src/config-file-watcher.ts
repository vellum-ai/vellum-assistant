/**
 * Watches config.json for changes to any top-level key.
 * Uses the same fs.watch() + debounce pattern as CredentialWatcher.
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import {
  CONFIG_FILENAME,
  getConfigPath,
  readConfigFileOrEmpty,
} from "./config-file-utils.js";
import { getLogger } from "./logger.js";

const log = getLogger("config-file-watcher");

const DEBOUNCE_MS = 500;

export type ConfigChangeEvent = {
  /** Full parsed config.json data. */
  data: Record<string, unknown>;
  /** Top-level keys whose serialized value changed since the last poll. */
  changedKeys: Set<string>;
  /**
   * Shallow object fields that changed for changed top-level object keys.
   * Non-object replacements are represented by the top-level key only.
   */
  changedFields: Map<string, Set<string>>;
};

export type ConfigChangeCallback = (event: ConfigChangeEvent) => void;

export class ConfigFileWatcher {
  private watcher: FSWatcher | null = null;
  private watchingDirectory = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSerialized: Map<string, string> = new Map();
  private lastValues: Map<string, unknown> = new Map();
  private callback: ConfigChangeCallback;
  private configPath: string;

  constructor(callback: ConfigChangeCallback) {
    this.callback = callback;
    this.configPath = getConfigPath();
  }

  start(): void {
    this.pollOnce();

    this.watchingDirectory = !existsSync(this.configPath);
    const watchTarget = this.watchingDirectory
      ? dirname(this.configPath)
      : this.configPath;

    try {
      this.watcher = watch(
        watchTarget,
        { persistent: false },
        (_event, filename) => {
          if (this.watchingDirectory && filename !== CONFIG_FILENAME) {
            return;
          }
          this.scheduleCheck();
        },
      );

      // Prevent unhandled FSWatcher errors (e.g. ENXIO when the watched
      // directory is removed) from crashing the process.
      this.watcher.on("error", (err) => {
        log.warn({ err, path: watchTarget }, "Config file watcher error");
      });

      log.info({ path: watchTarget }, "Watching for config file changes");
    } catch (err) {
      log.warn(
        { err, path: watchTarget },
        "Failed to start config file watcher",
      );
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private scheduleCheck(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.pollOnce();

      if (this.watchingDirectory && existsSync(this.configPath)) {
        this.upgradeWatcher();
      }
    }, DEBOUNCE_MS);
  }

  private upgradeWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (!existsSync(this.configPath)) return;

    try {
      this.watcher = watch(this.configPath, { persistent: false }, () => {
        this.scheduleCheck();
      });
      this.watchingDirectory = false;
      log.debug("Upgraded watcher to config file");
    } catch (err) {
      log.warn({ err }, "Failed to upgrade config file watcher");
    }
  }

  private pollOnce(): void {
    const data = readConfigFileOrEmpty({
      onMalformed: (detail) => {
        log.debug({ err: detail }, "Failed to read config file");
      },
    });

    const changedKeys = new Set<string>();
    const changedFields = new Map<string, Set<string>>();

    // Detect changed or added keys
    const allKeys = new Set([
      ...Object.keys(data),
      ...this.lastSerialized.keys(),
    ]);

    for (const key of allKeys) {
      const newVal = key in data ? JSON.stringify(data[key]) : undefined;
      const oldVal = this.lastSerialized.get(key);

      if (newVal !== oldVal) {
        changedKeys.add(key);
        const fieldChanges = diffObjectFields(
          this.lastValues.get(key),
          key in data ? data[key] : undefined,
        );
        if (fieldChanges.size > 0) {
          changedFields.set(key, fieldChanges);
        }
        if (newVal !== undefined) {
          this.lastSerialized.set(key, newVal);
          this.lastValues.set(key, data[key]);
        } else {
          this.lastSerialized.delete(key);
          this.lastValues.delete(key);
        }
      }
    }

    if (changedKeys.size === 0) return;

    log.info({ changedKeys: [...changedKeys] }, "Config file changed");

    this.callback({ data, changedKeys, changedFields });
  }
}

function diffObjectFields(oldValue: unknown, newValue: unknown): Set<string> {
  if (!isPlainRecord(oldValue) && !isPlainRecord(newValue)) {
    return new Set();
  }

  const oldRecord = isPlainRecord(oldValue) ? oldValue : {};
  const newRecord = isPlainRecord(newValue) ? newValue : {};
  const changed = new Set<string>();
  const allKeys = new Set([
    ...Object.keys(oldRecord),
    ...Object.keys(newRecord),
  ]);
  for (const key of allKeys) {
    const oldSerialized =
      key in oldRecord ? JSON.stringify(oldRecord[key]) : undefined;
    const newSerialized =
      key in newRecord ? JSON.stringify(newRecord[key]) : undefined;
    if (oldSerialized !== newSerialized) {
      changed.add(key);
    }
  }
  return changed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
