/**
 * Watches config.json for changes to any top-level key.
 * Uses the same fs.watch() + debounce pattern as CredentialWatcher.
 */

import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { getLogger } from "./logger.js";
import { getWorkspaceDir } from "./credential-reader.js";

const log = getLogger("config-file-watcher");

const DEBOUNCE_MS = 500;
const CONFIG_FILENAME = "config.json";

export type ConfigChangeEvent = {
  /** Full parsed config.json data. */
  data: Record<string, unknown>;
  /** Top-level keys whose serialized value changed since the last poll. */
  changedKeys: Set<string>;
};

export type ConfigChangeCallback = (event: ConfigChangeEvent) => void;

function getConfigPath(): string {
  return join(getWorkspaceDir(), CONFIG_FILENAME);
}

function readConfigFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};

    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};

    return data as Record<string, unknown>;
  } catch (err) {
    log.debug({ err }, "Failed to read config file");
    return {};
  }
}

export class ConfigFileWatcher {
  private watcher: FSWatcher | null = null;
  private watchingDirectory = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSerialized: Map<string, string> = new Map();
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
    const data = readConfigFile(this.configPath);

    const changedKeys = new Set<string>();

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
        if (newVal !== undefined) {
          this.lastSerialized.set(key, newVal);
        } else {
          this.lastSerialized.delete(key);
        }
      }
    }

    if (changedKeys.size === 0) return;

    log.info({ changedKeys: [...changedKeys] }, "Config file changed");

    this.callback({ data, changedKeys });
  }
}
