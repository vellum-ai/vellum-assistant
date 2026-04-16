/**
 * File watchers and config reload logic extracted from DaemonServer.
 * Watches workspace files (config, prompts) and skills directories
 * for changes.
 */
import {
  existsSync,
  type FSWatcher,
  mkdirSync,
  readdirSync,
  watch,
} from "node:fs";
import { join } from "node:path";

import { clearFeatureFlagOverridesCache } from "../config/assistant-feature-flags.js";
import { getConfig, invalidateConfigCache } from "../config/loader.js";
import type { MemoryCleanupConfig } from "../config/schemas/memory-lifecycle.js";
import { resetCleanupScheduleThrottle } from "../memory/cleanup-schedule-state.js";
import { clearEmbeddingBackendCache } from "../memory/embedding-backend.js";
import { clearCache as clearTrustCache } from "../permissions/trust-store.js";
import { initializeProviders } from "../providers/registry.js";
import { handleBashSignal } from "../signals/bash.js";
import { handleCancelSignal } from "../signals/cancel.js";
import { handleConversationUndoSignal } from "../signals/conversation-undo.js";
import { handleEmitEventSignal } from "../signals/emit-event.js";
import { handleMcpReloadSignal } from "../signals/mcp-reload.js";
import { handleShotgunSignal } from "../signals/shotgun.js";
import { handleUserMessageSignal } from "../signals/user-message.js";
import { DebouncerMap } from "../util/debounce.js";
import { getLogger } from "../util/logger.js";
import {
  AVATAR_IMAGE_FILENAME,
  getAvatarDir,
  getProtectedDir,
  getSignalsDir,
  getSoundsDir,
  getWorkspaceDir,
  getWorkspaceSkillsDir,
} from "../util/platform.js";

const log = getLogger("config-watcher");

/**
 * Attach a resilient error handler to an FSWatcher so that async errors
 * (e.g. ENXIO when a Unix socket file like `gateway.sock` appears in a
 * watched directory) are logged instead of crashing the process.
 */
function attachWatcherErrorHandler(watcher: FSWatcher, dir: string): void {
  watcher.on("error", (err) => {
    log.warn({ err, dir }, "FSWatcher error (non-fatal, continuing)");
  });
}

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
    const prevCleanup = safeGetCleanupConfig();
    invalidateConfigCache();
    const config = getConfig();
    const fingerprint = this.configFingerprint(config);
    if (fingerprint === this.lastFingerprint) {
      return false;
    }
    clearTrustCache();
    clearEmbeddingBackendCache();
    // If cleanup retention settings changed, reset the cleanup scheduler
    // throttle so the next worker tick re-enqueues jobs with the new values
    // instead of waiting out the remaining enqueueIntervalMs (default 6h).
    const nextCleanup = config.memory?.cleanup;
    if (cleanupSettingsChanged(prevCleanup, nextCleanup)) {
      resetCleanupScheduleThrottle();
    }
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
  start(
    onConversationEvict: () => void,
    onIdentityChanged?: () => void,
    onSoundsConfigChanged?: () => void,
    onAvatarChanged?: () => void,
    onConfigChanged?: () => void,
    onFeatureFlagsChanged?: () => void,
  ): void {
    const workspaceDir = getWorkspaceDir();

    const workspaceHandlers: Record<string, () => void> = {
      "config.json": async () => {
        if (this.suppressReload) return;
        try {
          const prevConfig = getConfig();
          const prevMcpFingerprint = JSON.stringify(prevConfig.mcp ?? {});
          const changed = await this.refreshConfigFromSources();
          if (changed) {
            onConversationEvict();
            onConfigChanged?.();
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
      "UPDATES.md": () => onConversationEvict(),
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
        attachWatcherErrorHandler(watcher, dir);
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

    if (onSoundsConfigChanged) {
      this.startSoundsWatcher(onSoundsConfigChanged);
    }
    if (onAvatarChanged) {
      this.startAvatarWatcher(onAvatarChanged);
    }

    this.startFeatureFlagsWatcher(onFeatureFlagsChanged);
    this.startSignalsWatcher();
    this.startUsersWatcher(onConversationEvict);
    this.startSkillsWatchers(onConversationEvict);
  }

  stop(): void {
    this.debounceTimers.cancelAll();
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  private startSoundsWatcher(onSoundsConfigChanged: () => void): void {
    const soundsDir = getSoundsDir();
    try {
      if (!existsSync(soundsDir)) {
        mkdirSync(soundsDir, { recursive: true });
      }
    } catch {
      // If we can't create it, watching will also fail — handled below.
    }

    try {
      const watcher = watch(soundsDir, (_eventType, filename) => {
        if (!filename) return;
        this.debounceTimers.schedule("file:sounds", () => {
          log.info(
            { file: String(filename) },
            "Sounds directory changed, notifying clients",
          );
          onSoundsConfigChanged();
        });
      });
      attachWatcherErrorHandler(watcher, soundsDir);
      this.watchers.push(watcher);
      log.info({ dir: soundsDir }, "Watching sounds directory for changes");
    } catch (err) {
      log.warn(
        { err, dir: soundsDir },
        "Failed to watch sounds directory. Sound config changes will require a restart.",
      );
    }
  }

  private startUsersWatcher(onConversationEvict: () => void): void {
    const usersDir = join(getWorkspaceDir(), "users");
    try {
      if (!existsSync(usersDir)) {
        mkdirSync(usersDir, { recursive: true });
      }
    } catch {
      // If we can't create it, watching will also fail — handled below.
    }

    try {
      const watcher = watch(usersDir, (_eventType, filename) => {
        if (!filename) return;
        const file = String(filename);
        if (!file.endsWith(".md")) return;
        this.debounceTimers.schedule(`file:users/${file}`, () => {
          log.info({ file }, "Users persona file changed, reloading");
          onConversationEvict();
        });
      });
      attachWatcherErrorHandler(watcher, usersDir);
      this.watchers.push(watcher);
      log.info(
        { dir: usersDir },
        "Watching users directory for persona changes",
      );
    } catch (err) {
      log.warn(
        { err, dir: usersDir },
        "Failed to watch users directory. Persona file changes will require a restart.",
      );
    }
  }

  private startAvatarWatcher(onAvatarChanged: () => void): void {
    const avatarDir = getAvatarDir();
    try {
      if (!existsSync(avatarDir)) {
        mkdirSync(avatarDir, { recursive: true });
      }
    } catch {
      // If we can't create it, watching will also fail — handled below.
    }

    try {
      const watcher = watch(avatarDir, (_eventType, filename) => {
        if (!filename) return;
        if (String(filename) !== AVATAR_IMAGE_FILENAME) return;
        this.debounceTimers.schedule("file:avatar", () => {
          log.info(
            { file: String(filename) },
            "Avatar image changed, notifying clients",
          );
          onAvatarChanged();
        });
      });
      attachWatcherErrorHandler(watcher, avatarDir);
      this.watchers.push(watcher);
      log.info({ dir: avatarDir }, "Watching avatar directory for changes");
    } catch (err) {
      log.warn(
        { err, dir: avatarDir },
        "Failed to watch avatar directory. Avatar changes will require a restart.",
      );
    }
  }

  private startFeatureFlagsWatcher(onFeatureFlagsChanged?: () => void): void {
    const protectedDir = process.env.GATEWAY_SECURITY_DIR || getProtectedDir();

    try {
      if (!existsSync(protectedDir)) {
        mkdirSync(protectedDir, { recursive: true });
      }
    } catch {
      // If we can't create it, watching will also fail — handled below.
    }

    const FLAG_FILES = new Set([
      "feature-flags.json",
      "feature-flags-remote.json",
    ]);

    try {
      const watcher = watch(protectedDir, (_eventType, filename) => {
        if (!filename) return;
        const file = String(filename);
        if (!FLAG_FILES.has(file)) return;
        this.debounceTimers.schedule(
          "file:feature-flags",
          () => {
            log.info(
              { file },
              "Feature flags file changed, invalidating cache",
            );
            clearFeatureFlagOverridesCache();
            onFeatureFlagsChanged?.();
          },
          500,
        );
      });
      attachWatcherErrorHandler(watcher, protectedDir);
      this.watchers.push(watcher);
      log.info(
        { dir: protectedDir },
        "Watching protected directory for feature flag changes",
      );
    } catch (err) {
      log.warn(
        { err, dir: protectedDir },
        "Failed to watch protected directory for feature flags. Flag changes will require a restart.",
      );
    }
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
      "mcp-reload": handleMcpReloadSignal,
      "conversation-undo": handleConversationUndoSignal,
      "emit-event": handleEmitEventSignal,
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
      attachWatcherErrorHandler(watcher, signalsDir);
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
      attachWatcherErrorHandler(recursiveWatcher, skillsDir);
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
        attachWatcherErrorHandler(watcher, dirPath);
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

/**
 * Snapshot the current cleanup config so we can compare it against the
 * post-reload value. Tolerant of config-load failures — if the config can't
 * be read (e.g. first-load), returns undefined so the comparison below
 * treats it as "no previous value".
 */
function safeGetCleanupConfig(): MemoryCleanupConfig | undefined {
  try {
    return getConfig().memory?.cleanup;
  } catch {
    return undefined;
  }
}

/**
 * Return true if any cleanup field the user can change via the UI differs
 * between the previous and next config snapshots. Used to decide whether to
 * reset the cleanup-scheduler throttle after a config reload so retention
 * changes take effect immediately instead of waiting up to 6 hours.
 *
 * Exported for unit testing.
 */
export function cleanupSettingsChanged(
  prev: MemoryCleanupConfig | undefined,
  next: MemoryCleanupConfig | undefined,
): boolean {
  if (!prev || !next) return false;
  return (
    prev.llmRequestLogRetentionMs !== next.llmRequestLogRetentionMs ||
    prev.conversationRetentionDays !== next.conversationRetentionDays ||
    prev.enabled !== next.enabled
  );
}
