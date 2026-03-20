/**
 * File watchers and config reload logic extracted from DaemonServer.
 * Watches workspace files (config, prompts), protected directory
 * (trust rules, secret allowlist), and skills directories for changes.
 */
import {
  existsSync,
  type FSWatcher,
  mkdirSync,
  readdirSync,
  watch,
} from "node:fs";
import { join } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import { getConfig, invalidateConfigCache } from "../config/loader.js";
import { clearEmbeddingBackendCache } from "../memory/embedding-backend.js";
import { clearCache as clearTrustCache } from "../permissions/trust-store.js";
import { initializeProviders } from "../providers/registry.js";
import {
  resetAllowlist,
  validateAllowlistFile,
} from "../security/secret-allowlist.js";
import { handleBashSignal } from "../signals/bash.js";
import { handleCancelSignal } from "../signals/cancel.js";
import { handleConfirmationSignal } from "../signals/confirm.js";
import { handleConversationUndoSignal } from "../signals/conversation-undo.js";
import { handleMcpReloadSignal } from "../signals/mcp-reload.js";
import { handleShotgunSignal } from "../signals/shotgun.js";
import { handleTrustRuleSignal } from "../signals/trust-rule.js";
import { handleUserMessageSignal } from "../signals/user-message.js";
import { DebouncerMap } from "../util/debounce.js";
import { getLogger } from "../util/logger.js";
import {
  getRootDir,
  getSignalsDir,
  getWorkspaceDir,
  getWorkspaceSkillsDir,
} from "../util/platform.js";

const log = getLogger("config-watcher");

export class ConfigWatcher {
  private watchers: FSWatcher[] = [];
  private debounceTimers = new DebouncerMap({
    defaultDelayMs: 200,
    maxEntries: 1000,
    protectedKeyPrefix: "__",
  });
  private suppressReload = false;
  lastFingerprint = "";
  private lastRefreshTime = 0;

  static readonly REFRESH_INTERVAL_MS = 30_000;

  /** Expose the debounce timers so handlers can schedule debounced work. */
  get timers(): DebouncerMap {
    return this.debounceTimers;
  }

  get suppressConfigReload(): boolean {
    return this.suppressReload;
  }

  set suppressConfigReload(value: boolean) {
    this.suppressReload = value;
  }

  get lastConfigRefreshTime(): number {
    return this.lastRefreshTime;
  }

  set lastConfigRefreshTime(value: number) {
    this.lastRefreshTime = value;
  }

  /** Compute a fingerprint of the current config for change detection. */
  configFingerprint(config: ReturnType<typeof getConfig>): string {
    return JSON.stringify(config);
  }

  /** Initialize the config fingerprint (call after first config load). */
  initFingerprint(config: ReturnType<typeof getConfig>): void {
    this.lastFingerprint = this.configFingerprint(config);
  }

  /** Update the fingerprint to match the current config. */
  updateFingerprint(): void {
    this.lastFingerprint = this.configFingerprint(getConfig());
    this.lastRefreshTime = Date.now();
  }

  /**
   * Reload config from disk + secure storage, and refresh providers only
   * when effective config values (including API keys) have changed.
   * Returns true if config actually changed.
   */
  async refreshConfigFromSources(): Promise<boolean> {
    invalidateConfigCache();
    const config = getConfig();
    const fingerprint = this.configFingerprint(config);
    if (fingerprint === this.lastFingerprint) {
      return false;
    }
    clearTrustCache();
    clearEmbeddingBackendCache();
    const isFirstInit = this.lastFingerprint === "";
    await initializeProviders(config);
    this.lastFingerprint = fingerprint;
    return !isFirstInit;
  }

  /**
   * Start all file watchers. `onConversationEvict` is called when watched
   * files change and conversations need to be evicted for reload.
   * `onIdentityChanged` is called when IDENTITY.md changes on disk.
   */
  start(onConversationEvict: () => void, onIdentityChanged?: () => void): void {
    const workspaceDir = getWorkspaceDir();
    const protectedDir = join(getRootDir(), "protected");

    const workspaceHandlers: Record<string, () => void> = {
      "config.json": async () => {
        if (this.suppressReload) return;
        try {
          const prevConfig = getConfig();
          const prevMcpFingerprint = JSON.stringify(prevConfig.mcp ?? {});
          const changed = await this.refreshConfigFromSources();
          if (changed) {
            onConversationEvict();
            const newConfig = getConfig();
            const newMcpFingerprint = JSON.stringify(newConfig.mcp ?? {});
            if (newMcpFingerprint !== prevMcpFingerprint) {
              handleMcpReloadSignal();
            }
          }
        } catch (err) {
          log.error(
            { err, configPath: join(workspaceDir, "config.json") },
            "Failed to reload config after file change. Previous config remains active.",
          );
        }
      },
      "SOUL.md": () => onConversationEvict(),
      "IDENTITY.md": () => {
        onConversationEvict();
        onIdentityChanged?.();
      },
      "USER.md": () => onConversationEvict(),
      "UPDATES.md": () => onConversationEvict(),
    };

    const protectedHandlers: Record<string, () => void> = {
      "trust.json": () => {
        clearTrustCache();
      },
      "secret-allowlist.json": () => {
        resetAllowlist();
        try {
          const errors = validateAllowlistFile();
          if (errors && errors.length > 0) {
            for (const e of errors) {
              log.warn(
                { index: e.index, pattern: e.pattern },
                `Invalid regex in secret-allowlist.json: ${e.message}`,
              );
            }
          }
        } catch (err) {
          log.warn({ err }, "Failed to validate secret-allowlist.json");
        }
      },
    };

    const watchDir = (
      dir: string,
      handlers: Record<string, () => void>,
      label: string,
    ): void => {
      try {
        const watcher = watch(dir, (_eventType, filename) => {
          if (!filename) return;
          const file = String(filename);
          if (!handlers[file]) return;
          this.debounceTimers.schedule(`file:${file}`, () => {
            log.info({ file }, "File changed, reloading");
            handlers[file]();
          });
        });
        this.watchers.push(watcher);
        log.info({ dir }, `Watching ${label}`);
      } catch (err) {
        log.warn(
          { err, dir },
          `Failed to watch ${label}. Hot-reload will be unavailable.`,
        );
      }
    };

    watchDir(
      workspaceDir,
      workspaceHandlers,
      "workspace directory for config/prompt changes",
    );
    if (existsSync(protectedDir)) {
      watchDir(
        protectedDir,
        protectedHandlers,
        "protected directory for trust/allowlist changes",
      );
    }

    if (!getIsContainerized()) {
      this.startSignalsWatcher();
    }
    this.startSkillsWatchers(onConversationEvict);
  }

  stop(): void {
    this.debounceTimers.cancelAll();
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  private startSignalsWatcher(): void {
    const signalsDir = getSignalsDir();
    try {
      if (!existsSync(signalsDir)) {
        mkdirSync(signalsDir, { recursive: true });
      }
    } catch {
      // If we can't create it, watching will also fail — handled below.
    }

    const exactSignalHandlers: Record<string, () => void | Promise<void>> = {
      cancel: handleCancelSignal,
      confirm: handleConfirmationSignal,
      "mcp-reload": handleMcpReloadSignal,
      "trust-rule": handleTrustRuleSignal,
      "conversation-undo": handleConversationUndoSignal,
    };

    const prefixSignalHandlers: Record<
      string,
      (filename: string) => void | Promise<void>
    > = {
      "bash.": handleBashSignal,
      "shotgun.": handleShotgunSignal,
      "user-message.": handleUserMessageSignal,
    };

    try {
      const watcher = watch(signalsDir, (_eventType, filename) => {
        if (!filename) return;
        const file = String(filename);

        if (exactSignalHandlers[file]) {
          this.debounceTimers.schedule(`signal:${file}`, () => {
            log.info({ file }, "Signal file detected");
            exactSignalHandlers[file]();
          });
          return;
        }

        for (const [prefix, handler] of Object.entries(prefixSignalHandlers)) {
          if (file.startsWith(prefix) && !file.endsWith(".result")) {
            this.debounceTimers.schedule(`signal:${file}`, () => {
              log.info({ file }, "Signal file detected");
              handler(file);
            });
            return;
          }
        }
      });
      this.watchers.push(watcher);
      log.info({ dir: signalsDir }, "Watching signals directory");
    } catch (err) {
      log.warn(
        { err, dir: signalsDir },
        "Failed to watch signals directory. Signal-based reload will be unavailable.",
      );
    }
  }

  private startSkillsWatchers(onConversationEvict: () => void): void {
    const skillsDir = getWorkspaceSkillsDir();
    if (!existsSync(skillsDir)) return;

    const scheduleSkillsReload = (file: string): void => {
      this.debounceTimers.schedule(`skills:${file}`, () => {
        log.info({ file }, "Skill file changed, reloading");
        onConversationEvict();
      });
    };

    try {
      const recursiveWatcher = watch(
        skillsDir,
        { recursive: true },
        (_eventType, filename) => {
          scheduleSkillsReload(filename ? String(filename) : "(unknown)");
        },
      );
      this.watchers.push(recursiveWatcher);
      log.info({ dir: skillsDir }, "Watching skills directory recursively");
      return;
    } catch (err) {
      log.info(
        { err, dir: skillsDir },
        "Recursive skills watch unavailable; using per-directory watchers",
      );
    }

    const childWatchers = new Map<string, FSWatcher>();

    const watchDir = (
      dirPath: string,
      onChange: (filename: string) => void,
    ): FSWatcher | null => {
      try {
        const watcher = watch(dirPath, (_eventType, filename) => {
          onChange(filename ? String(filename) : "(unknown)");
        });
        this.watchers.push(watcher);
        return watcher;
      } catch (err) {
        log.warn({ err, dirPath }, "Failed to watch skills directory");
        return null;
      }
    };

    const removeWatcher = (watcher: FSWatcher): void => {
      const idx = this.watchers.indexOf(watcher);
      if (idx !== -1) {
        this.watchers.splice(idx, 1);
      }
    };

    const refreshChildWatchers = (): void => {
      const nextChildDirs = new Set<string>();

      try {
        const entries = readdirSync(skillsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const childDir = join(skillsDir, entry.name);
          nextChildDirs.add(childDir);

          if (childWatchers.has(childDir)) continue;

          const watcher = watchDir(childDir, (filename) => {
            const label =
              filename === "(unknown)"
                ? entry.name
                : `${entry.name}/${filename}`;
            scheduleSkillsReload(label);
          });
          if (watcher) {
            childWatchers.set(childDir, watcher);
          }
        }
      } catch (err) {
        log.warn({ err, skillsDir }, "Failed to enumerate skill directories");
        return;
      }

      for (const [childDir, watcher] of childWatchers.entries()) {
        if (nextChildDirs.has(childDir)) continue;
        watcher.close();
        childWatchers.delete(childDir);
        removeWatcher(watcher);
      }
    };

    const rootWatcher = watchDir(skillsDir, (filename) => {
      scheduleSkillsReload(filename);
      refreshChildWatchers();
    });

    if (!rootWatcher) return;

    refreshChildWatchers();
    log.info(
      { dir: skillsDir },
      "Watching skills directory with non-recursive fallback",
    );
  }
}
