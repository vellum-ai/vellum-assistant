/**
 * File watchers and config reload logic extracted from DaemonServer.
 * Watches workspace files (config, prompts) and skills directories
 * for changes.
 */
import {
  type Dirent,
  existsSync,
  type FSWatcher,
  mkdirSync,
  readdirSync,
  readFileSync,
  unwatchFile,
  watch,
  watchFile,
} from "node:fs";
import { join, relative } from "node:path";

import { getConfig, invalidateConfigCache } from "../config/loader.js";
import type { MemoryCleanupConfig } from "../config/schemas/memory-lifecycle.js";
import { resetCleanupScheduleThrottle } from "../persistence/cleanup-schedule-state.js";
import { clearEmbeddingBackendCache } from "../persistence/embeddings/embedding-backend.js";
import { syncIdentityNameToPlatform } from "../platform/sync-identity.js";
import { initializeProviders } from "../providers/registry.js";
import {
  publishAvatarChanged,
  publishConfigChanged,
  publishIdentityChanged,
  publishSoundsConfigUpdated,
} from "../runtime/sync/resource-sync-events.js";
import { handleCancelSignal } from "../signals/cancel.js";
import { handleConversationUndoSignal } from "../signals/conversation-undo.js";
import { handleEmitEventSignal } from "../signals/emit-event.js";
import { handleUserMessageSignal } from "../signals/user-message.js";
import { DebouncerMap } from "../util/debounce.js";
import { getLogger } from "../util/logger.js";
import {
  AVATAR_IMAGE_FILENAME,
  getAvatarDir,
  getSignalsDir,
  getSoundsDir,
  getWorkspaceDir,
  getWorkspacePromptPath,
  getWorkspaceSkillsDir,
} from "../util/platform.js";
import { evictConversationsForReload } from "./conversation-store.js";
import { parseIdentityFields } from "./handlers/identity.js";
import { reloadMcpServers } from "./mcp-reload-service.js";
import { refreshSkillCapabilityMemories } from "./skill-memory-refresh.js";

const log = getLogger("config-watcher");

const SKILL_WATCH_SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".install-staging",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "coverage",
]);

function isSkippedSkillWatchPath(relativePath: string): boolean {
  if (relativePath === "(unknown)") return false;

  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  return segments.some((segment) => SKILL_WATCH_SKIPPED_DIRS.has(segment));
}

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

/**
 * Poll interval for `fs.watchFile()`. Use the stat-polling watcher
 * because Bun's per-file `fs.watch()` doesn't detect renames on Linux
 * (seemingly works on macOS). See https://github.com/oven-sh/bun/issues/15010.
 */
const WATCH_FILE_POLL_MS = 2_000;

export class ConfigWatcher {
  private watchers: FSWatcher[] = [];
  private watchedFiles: Set<string> = new Set();
  private stopped = false;
  private debounceTimers: DebouncerMap;
  private suppressReload = false;
  lastFingerprint = "";
  private lastConfig: ReturnType<typeof getConfig> | null = null;
  private lastRefreshTime = 0;

  static readonly REFRESH_INTERVAL_MS = 30_000;

  /**
   * @param pollIntervalMs Per-file stat poll interval (passed to
   *   `fs.watchFile`). Default `WATCH_FILE_POLL_MS` (2s); tests pass a
   *   smaller value for fast turnaround.
   * @param debounceMs Debounce window applied to any detected file
   *   change before invoking its handler. Default 200ms; tests pass a
   *   smaller value to avoid sleeping unnecessarily.
   */
  constructor(
    private readonly pollIntervalMs: number = WATCH_FILE_POLL_MS,
    debounceMs = 200,
  ) {
    this.debounceTimers = new DebouncerMap({
      defaultDelayMs: debounceMs,
      maxEntries: 1000,
      protectedKeyPrefix: "__",
    });
  }

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
    this.lastConfig = config;
    this.lastFingerprint = this.configFingerprint(config);
  }

  /** Update the fingerprint to match the current config. */
  updateFingerprint(): void {
    const config = getConfig();
    this.lastConfig = config;
    this.lastFingerprint = this.configFingerprint(config);
    this.lastRefreshTime = Date.now();
  }

  /**
   * Reload config from disk + secure storage, and refresh providers only
   * when effective config values (including API keys) have changed.
   * Returns true if config actually changed.
   */
  async refreshConfigFromSources(): Promise<boolean> {
    const prevCleanup = this.lastConfig?.memory?.cleanup;
    invalidateConfigCache();
    const config = getConfig();
    const fingerprint = this.configFingerprint(config);
    if (fingerprint === this.lastFingerprint) {
      return false;
    }
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
    this.lastConfig = config;
    this.lastFingerprint = fingerprint;
    return !isFirstInit;
  }

  /**
   * Start all file watchers. On a detected change the watcher reacts directly:
   * evicting conversations so the next turn rebuilds against the new config,
   * broadcasting the relevant resource-changed events to clients, and
   * refreshing skill capability memories after skill directory changes.
   */
  start(): void {
    // Reset the stopped flag so a stop()→start() cycle on the same
    // instance resumes hot-reload instead of silently bailing in every
    // watchFile callback. This matters because getConfigWatcher() is a
    // module-level singleton — a daemon restart path that reuses it
    // would otherwise be permanently mute.
    this.stopped = false;
    const workspaceDir = getWorkspaceDir();

    const workspaceHandlers: Record<string, () => void> = {
      "config.json": async () => {
        if (this.suppressReload) return;
        try {
          const prevMcpFingerprint = JSON.stringify(this.lastConfig?.mcp ?? {});
          const changed = await this.refreshConfigFromSources();
          if (changed) {
            evictConversationsForReload();
            publishConfigChanged();
            const newConfig = this.lastConfig ?? getConfig();
            const newMcpFingerprint = JSON.stringify(newConfig.mcp ?? {});
            if (newMcpFingerprint !== prevMcpFingerprint) {
              reloadMcpServers().catch((err: unknown) => {
                log.error({ err }, "MCP reload after config change failed");
              });
            }
          }
        } catch (err) {
          log.error(
            { err, configPath: join(workspaceDir, "config.json") },
            "Failed to reload config after file change. Previous config remains active.",
          );
        }
      },
      "SOUL.md": () => {
        evictConversationsForReload();
      },
      "IDENTITY.md": () => {
        evictConversationsForReload();
        broadcastIdentityChange();
      },
    };

    // Per-file watches; don't watch the workspace directory itself because
    // it contains socket files.
    for (const [filename, handler] of Object.entries(workspaceHandlers)) {
      this.watchFile(join(workspaceDir, filename), handler, filename);
    }

    this.startSoundsWatcher();
    this.startAvatarWatcher();
    this.startSignalsWatcher();
    this.startUsersWatcher();
    this.startSkillsWatchers();
  }

  stop(): void {
    this.stopped = true;
    this.debounceTimers.cancelAll();
    for (const filePath of this.watchedFiles) {
      unwatchFile(filePath);
    }
    this.watchedFiles.clear();
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  private watchFile(
    filePath: string,
    handler: () => void,
    label: string,
  ): void {
    // Match the defensive pattern used by every other startXWatcher in
    // this file: log the failure and continue. Per AGENTS.md, the daemon
    // must never block startup — a watchFile() throw on some platform
    // edge case must not propagate up to DaemonServer.start().
    try {
      watchFile(filePath, { interval: this.pollIntervalMs }, (curr, prev) => {
        if (this.stopped) return;
        if (curr.ino === prev.ino && curr.mtimeMs === prev.mtimeMs) return;
        this.debounceTimers.schedule(`file:${filePath}`, () => {
          log.info({ file: filePath }, "File changed, reloading");
          handler();
        });
      });
      this.watchedFiles.add(filePath);
      log.info({ file: filePath }, `Watching ${label}`);
    } catch (err) {
      log.warn(
        { err, file: filePath },
        `Failed to watch ${label}. Hot-reload will be unavailable until restart.`,
      );
    }
  }

  private startSoundsWatcher(): void {
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
          publishSoundsConfigUpdated();
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

  private startUsersWatcher(): void {
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
          evictConversationsForReload();
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

  private startAvatarWatcher(): void {
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
          publishAvatarChanged();
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
      "conversation-undo": handleConversationUndoSignal,
      "emit-event": handleEmitEventSignal,
    };

    const prefixSignalHandlers: Record<
      string,
      (filename: string) => void | Promise<void>
    > = {
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

  private startSkillsWatchers(): void {
    const skillsDir = getWorkspaceSkillsDir();
    if (!existsSync(skillsDir)) return;

    const scheduleSkillsReload = (file: string): void => {
      if (isSkippedSkillWatchPath(file)) return;

      this.debounceTimers.schedule("skills:catalog", () => {
        log.info({ file }, "Skill file changed, reloading");
        evictConversationsForReload();
        refreshSkillCapabilityMemories(getConfig());
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

    const formatSkillChangeLabel = (
      dirPath: string,
      filename: string,
    ): string => {
      if (filename === "(unknown)") {
        const relativeDir = relative(skillsDir, dirPath);
        return relativeDir || "(unknown)";
      }
      const relativeFile = relative(skillsDir, join(dirPath, filename));
      return relativeFile || filename;
    };

    const enumerateSkillSubdirectories = (
      dirPath: string,
      acc: Set<string>,
    ): boolean => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dirPath, { withFileTypes: true });
      } catch (err) {
        log.warn({ err, dirPath }, "Failed to enumerate skill directories");
        return dirPath !== skillsDir;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SKILL_WATCH_SKIPPED_DIRS.has(entry.name)) continue;
        const childDir = join(dirPath, entry.name);
        acc.add(childDir);
        enumerateSkillSubdirectories(childDir, acc);
      }
      return true;
    };

    const closeChildWatcher = (dirPath: string, watcher: FSWatcher): void => {
      watcher.close();
      childWatchers.delete(dirPath);
      removeWatcher(watcher);
    };

    const refreshChildWatchers = (): void => {
      const nextChildDirs = new Set<string>();
      if (!enumerateSkillSubdirectories(skillsDir, nextChildDirs)) {
        for (const [childDir, watcher] of childWatchers.entries()) {
          closeChildWatcher(childDir, watcher);
        }
        return;
      }

      for (const [childDir, watcher] of childWatchers.entries()) {
        if (nextChildDirs.has(childDir)) continue;
        closeChildWatcher(childDir, watcher);
      }

      for (const childDir of nextChildDirs) {
        if (childWatchers.has(childDir)) continue;

        const watcher = watchDir(childDir, (filename) => {
          const file = formatSkillChangeLabel(childDir, filename);
          if (isSkippedSkillWatchPath(file)) return;

          scheduleSkillsReload(file);
          refreshChildWatchers();
        });
        if (watcher) {
          childWatchers.set(childDir, watcher);
        }
      }
    };

    const rootWatcher = watchDir(skillsDir, (filename) => {
      if (isSkippedSkillWatchPath(filename)) return;

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
 * Re-read IDENTITY.md and broadcast the parsed fields to clients, best-effort
 * syncing the assistant name to the platform record. The config watcher's
 * IDENTITY.md-change reaction.
 */
function broadcastIdentityChange(): void {
  try {
    const identityPath = getWorkspacePromptPath("IDENTITY.md");
    const content = existsSync(identityPath)
      ? readFileSync(identityPath, "utf-8")
      : "";
    const fields = parseIdentityFields(content);
    publishIdentityChanged(fields);
    if (fields.name) {
      syncIdentityNameToPlatform(fields.name);
    }
  } catch (err) {
    log.error({ err }, "Failed to broadcast identity change");
  }
}

// ─── Module-level singleton ──────────────────────────────────────────────────

let _instance: ConfigWatcher | undefined;

/**
 * Return the global ConfigWatcher instance, lazily creating it on first access.
 */
export function getConfigWatcher(): ConfigWatcher {
  if (!_instance) {
    _instance = new ConfigWatcher();
  }
  return _instance;
}

/**
 * Initialize the config fingerprint and start all workspace file watchers.
 * Called once during daemon startup.
 */
export function startConfigWatcher(): void {
  const watcher = getConfigWatcher();
  watcher.initFingerprint(getConfig());
  watcher.start();
}

/** Stop the config watcher during daemon shutdown. */
export function stopConfigWatcher(): void {
  getConfigWatcher().stop();
}

export function cleanupSettingsChanged(
  prev: MemoryCleanupConfig | undefined,
  next: MemoryCleanupConfig | undefined,
): boolean {
  if (!prev || !next) return false;
  return (
    prev.llmRequestLogRetentionMs !== next.llmRequestLogRetentionMs ||
    prev.conversationRetentionDays !== next.conversationRetentionDays ||
    prev.traceEventRetentionDays !== next.traceEventRetentionDays ||
    prev.enabled !== next.enabled
  );
}
