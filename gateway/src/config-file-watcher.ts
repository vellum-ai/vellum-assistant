/**
 * Watches config.json for changes to any top-level key.
 * Always watches the parent directory (not the file) for the same
 * atomic-rename resilience reasons as CredentialWatcher — see its
 * module doc for details.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { dirname, join } from "node:path";
import { getLogger } from "./logger.js";
import { getRootDir } from "./credential-reader.js";

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
  return join(getRootDir(), "workspace", CONFIG_FILENAME);
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
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSerialized: Map<string, string> = new Map();
  private callback: ConfigChangeCallback;
  private configPath: string;
  private configDir: string;

  constructor(callback: ConfigChangeCallback) {
    this.callback = callback;
    this.configPath = getConfigPath();
    this.configDir = dirname(this.configPath);
  }

  start(): void {
    this.pollOnce();

    // Always watch the directory — file watches can break on atomic
    // rename writes (kqueue tracks inodes, not paths).
    mkdirSync(this.configDir, { recursive: true });

    try {
      this.watcher = watch(
        this.configDir,
        { persistent: false },
        (_event, filename) => {
          if (filename !== CONFIG_FILENAME) {
            return;
          }
          this.scheduleCheck();
        },
      );

      log.info(
        { path: this.configDir },
        "Watching directory for config file changes",
      );
    } catch (err) {
      log.warn(
        { err, path: this.configDir },
        "Failed to start config directory watcher",
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
    }, DEBOUNCE_MS);
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
