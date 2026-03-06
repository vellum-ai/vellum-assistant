/**
 * File watchers and config reload logic extracted from DaemonServer.
 * Watches workspace files (config, prompts), protected directory
 * (trust rules, secret allowlist), skills directories, and the repo-level
 * /skills directory for changes.
 */
import {
  cpSync,
  existsSync,
  type FSWatcher,
  readdirSync,
  watch,
} from "node:fs";
import { join } from "node:path";

import { getConfig, invalidateConfigCache } from "../config/loader.js";
import { clearEmbeddingBackendCache } from "../memory/embedding-backend.js";
import { clearCache as clearTrustCache } from "../permissions/trust-store.js";
import { initializeProviders } from "../providers/registry.js";
import {
  resetAllowlist,
  validateAllowlistFile,
} from "../security/secret-allowlist.js";
import { DebouncerMap } from "../util/debounce.js";
import { getLogger } from "../util/logger.js";
import {
  getRootDir,
  getWorkspaceDir,
  getWorkspaceSkillsDir,
} from "../util/platform.js";

const log = getLogger("config-watcher");

/**
 * Resolve the repo-level /skills directory from the source tree.
 * Returns null when running from a compiled binary (where import.meta.dir
 * points into /$bunfs/) or when the directory does not exist on disk.
 */
function resolveRepoSkillsDir(): string | null {
  const srcDir = import.meta.dir;
  if (srcDir.startsWith("/$bunfs/")) return null;
  // srcDir is assistant/src/daemon/ — go up three levels to the repo root
  const dir = join(srcDir, "..", "..", "..", "skills");
  return existsSync(dir) ? dir : null;
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
  refreshConfigFromSources(): boolean {
    invalidateConfigCache();
    const config = getConfig();
    const fingerprint = this.configFingerprint(config);
    if (fingerprint === this.lastFingerprint) {
      return false;
    }
    clearTrustCache();
    clearEmbeddingBackendCache();
    const isFirstInit = this.lastFingerprint === "";
    initializeProviders(config);
    this.lastFingerprint = fingerprint;
    return !isFirstInit;
  }

  /**
   * Start all file watchers. `onSessionEvict` is called when watched
   * files change and sessions need to be evicted for reload.
   * `onIdentityChanged` is called when IDENTITY.md changes on disk.
   */
  start(onSessionEvict: () => void, onIdentityChanged?: () => void): void {
    const workspaceDir = getWorkspaceDir();
    const protectedDir = join(getRootDir(), "protected");

    const workspaceHandlers: Record<string, () => void> = {
      "config.json": () => {
        if (this.suppressReload) return;
        try {
          const changed = this.refreshConfigFromSources();
          if (changed) onSessionEvict();
        } catch (err) {
          log.error(
            { err, configPath: join(workspaceDir, "config.json") },
            "Failed to reload config after file change. Previous config remains active.",
          );
        }
      },
      "SOUL.md": () => onSessionEvict(),
      "IDENTITY.md": () => {
        onSessionEvict();
        onIdentityChanged?.();
      },
      "USER.md": () => onSessionEvict(),
      "UPDATES.md": () => onSessionEvict(),
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

    this.startSkillsWatchers(onSessionEvict);
    this.startRepoSkillsWatcher();
  }

  stop(): void {
    this.debounceTimers.cancelAll();
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  /**
   * Watch the repo-level /skills directory. When a skill file changes and
   * the workspace already contains that skill, copy the updated content
   * into the workspace so the existing workspace watcher picks up the
   * change and triggers a session reload.
   */
  private startRepoSkillsWatcher(): void {
    const repoSkillsDir = resolveRepoSkillsDir();
    if (!repoSkillsDir) return;

    const workspaceSkillsDir = getWorkspaceSkillsDir();

    const syncSkillToWorkspace = (skillName: string): void => {
      const repoSkillDir = join(repoSkillsDir, skillName);
      const workspaceSkillDir = join(workspaceSkillsDir, skillName);

      // Only sync when the skill is already installed in the workspace
      if (!existsSync(workspaceSkillDir)) return;
      // Only sync actual skill directories (must contain SKILL.md)
      if (!existsSync(join(repoSkillDir, "SKILL.md"))) return;

      try {
        cpSync(repoSkillDir, workspaceSkillDir, {
          recursive: true,
          force: true,
        });
        log.info({ skillName }, "Synced repo skill to workspace");
      } catch (err) {
        log.warn({ err, skillName }, "Failed to sync repo skill to workspace");
      }
    };

    const scheduleSync = (skillName: string): void => {
      this.debounceTimers.schedule(`repo-skill:${skillName}`, () => {
        syncSkillToWorkspace(skillName);
      });
    };

    /** Extract the top-level skill directory name from a watcher filename. */
    const extractSkillName = (filename: string): string | null => {
      const first = filename.split(/[\/\\]/)[0];
      return first && first !== "." ? first : null;
    };

    // Try recursive watching first (native on macOS, supported on modern Linux)
    try {
      const watcher = watch(
        repoSkillsDir,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return;
          const skillName = extractSkillName(String(filename));
          if (skillName) scheduleSync(skillName);
        },
      );
      this.watchers.push(watcher);
      log.info(
        { dir: repoSkillsDir },
        "Watching repo skills directory for workspace sync",
      );
      return;
    } catch {
      // Fall through to per-directory fallback
    }

    // Non-recursive fallback: watch root + each skill subdirectory
    try {
      const rootWatcher = watch(repoSkillsDir, (_eventType, filename) => {
        if (!filename) return;
        scheduleSync(String(filename));
      });
      this.watchers.push(rootWatcher);

      const entries = readdirSync(repoSkillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const childWatcher = watch(
            join(repoSkillsDir, entry.name),
            () => scheduleSync(entry.name),
          );
          this.watchers.push(childWatcher);
        } catch {
          // Skip individual directory failures
        }
      }

      log.info(
        { dir: repoSkillsDir },
        "Watching repo skills directory with non-recursive fallback",
      );
    } catch (err) {
      log.warn(
        { err, dir: repoSkillsDir },
        "Failed to watch repo skills directory",
      );
    }
  }

  private startSkillsWatchers(onSessionEvict: () => void): void {
    const skillsDir = getWorkspaceSkillsDir();
    if (!existsSync(skillsDir)) return;

    const scheduleSkillsReload = (file: string): void => {
      this.debounceTimers.schedule(`skills:${file}`, () => {
        log.info({ file }, "Skill file changed, reloading");
        onSessionEvict();
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
