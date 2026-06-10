/**
 * Filesystem watcher for `<workspaceDir>/tools/`.
 *
 * Watches the workspace-tools directory non-recursively using fs.watch.
 * On any add/change/delete event, debounces per filename stem (= tool
 * name) and reconciles registry state against on-disk state: registers
 * newly added tools, re-imports changed tools (cache-busting via the
 * loader's per-import URL query string), unregisters deleted tools,
 * strips core tools when a `.removed` sentinel appears, restores them
 * when the sentinel disappears.
 *
 * No assistant restart is required — the file watcher closes the
 * "edit a file, see the change" loop the same way the apps watcher and
 * plugin source watcher do for their respective directories.
 *
 * ## Why per-stem reconciliation
 *
 * The watcher receives `(eventType, filename)` from fs.watch but the
 * eventType ("rename" vs "change") is unreliable across editors and
 * platforms — vim atomic-save shows as a rename of the original file
 * plus an add of a new file, VS Code shows as a change in place, etc.
 * Rather than route on eventType, we debounce per stem and re-derive
 * the world: "given what's on disk right now for `<stem>.*`, what
 * registry state should the assistant be in?"
 *
 * This is the same eventual-consistency pattern as
 * `plugin-source-watcher.ts` — the watcher exists to KICK the
 * reconciler, not to be the source of truth about what changed.
 *
 * ## Lifecycle position
 *
 * Started after the initial `loadWorkspaceTools()` scan completes
 * during daemon startup, gated on the `workspace-tools-watcher` feature
 * flag — when the flag is off the initial scan still runs but no watch
 * loop is mounted, so workspace tools load from disk once and live edits
 * need a restart. Stopped on assistant shutdown alongside the
 * other long-lived watchers. Stoppage during shutdown does not
 * unregister tools — those go away with the process; the watcher's
 * only job is to keep the registry fresh while the assistant is up.
 */

import { existsSync, type FSWatcher, watch } from "node:fs";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import {
  getCoreToolOverride,
  getTool,
  getToolOwner,
  removeCoreToolViaWorkspace,
  restoreStrippedCoreTool,
  unregisterWorkspaceTool,
} from "../tools/registry.js";
import {
  classifyWorkspaceToolEntry,
  findWinningWorkspaceToolPath,
  loadSingleWorkspaceTool,
} from "../tools/workspace-tools/loader.js";
import { DebouncerMap } from "../util/debounce.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceToolsDir } from "../util/platform.js";

const log = getLogger("workspace-tools-watcher");

/**
 * Gates the dynamic hot-reload path. When disabled, workspace tools still
 * load from disk once at daemon startup via {@link loadWorkspaceTools}; only
 * the live watch → re-registration loop is suppressed. Read at its point of
 * use in {@link WorkspaceToolsWatcher.start} so a daemon restart picks up a
 * changed value.
 */
const WORKSPACE_TOOLS_WATCHER_FLAG = "workspace-tools-watcher" as const;

/**
 * Wait this long after the last fs event for a given stem before
 * reconciling. Editor saves often emit a burst of 2–4 events; the
 * debounce collapses them into a single load.
 */
const RECONCILE_DEBOUNCE_MS = 250;

export class WorkspaceToolsWatcher {
  /**
   * Process-wide singleton. Callers reach the watcher via
   * {@link WorkspaceToolsWatcher.getInstance} rather than instantiating
   * directly so the daemon `start()`/`stop()` lifecycle and any future
   * "trigger a manual reconcile" code paths share one watcher across the
   * assistant process lifetime.
   */
  private static singleton: WorkspaceToolsWatcher | null = null;

  static getInstance(): WorkspaceToolsWatcher {
    WorkspaceToolsWatcher.singleton ??= new WorkspaceToolsWatcher();
    return WorkspaceToolsWatcher.singleton;
  }

  /** Test-only — drops the singleton so the next `getInstance()` rebuilds. */
  static resetForTests(): void {
    WorkspaceToolsWatcher.singleton?.stop();
    WorkspaceToolsWatcher.singleton = null;
  }

  /** Test-only — whether a live `fs.watch` loop is currently mounted. */
  isWatchingForTests(): boolean {
    return this.watcher !== null;
  }

  private watcher: FSWatcher | null = null;
  private debouncer = new DebouncerMap({
    defaultDelayMs: RECONCILE_DEBOUNCE_MS,
    maxEntries: 100,
  });
  /**
   * Promise queue per stem — guarantees that two events for the same
   * stem can't run concurrently and corrupt the unregister/load
   * sequence. The queue is single-deep (the chained promise simply
   * awaits the in-flight one before running its own work), so the
   * debouncer's collapsing already does most of the deduplication; this
   * queue exists for the case where a second event lands during the
   * in-flight reconcile's `await loadSingleWorkspaceTool`.
   */
  private inflight = new Map<string, Promise<void>>();

  start(): void {
    if (this.watcher) return;
    if (
      !isAssistantFeatureFlagEnabled(WORKSPACE_TOOLS_WATCHER_FLAG, getConfig())
    ) {
      log.debug(
        "Workspace tools watcher disabled by feature flag; workspace tools load from disk at startup only (restart required to pick up edits)",
      );
      return;
    }
    const toolsDir = getWorkspaceToolsDir();
    if (!existsSync(toolsDir)) {
      log.debug(
        { toolsDir },
        "Workspace tools directory does not exist; watcher not started (will not auto-start on directory creation — restart required)",
      );
      return;
    }
    try {
      this.watcher = watch(
        toolsDir,
        { recursive: false },
        (_eventType, filename) => {
          if (!filename) return;
          const classified = classifyWorkspaceToolEntry(filename);
          if (!classified) {
            // Not a workspace-tool file — ignore (README.md, .DS_Store, etc.)
            return;
          }
          this.debouncer.schedule(`stem:${classified.stem}`, () => {
            this.scheduleReconcile(classified.stem);
          });
        },
      );
      log.info({ toolsDir }, "Workspace tools watcher started");
    } catch (err) {
      log.warn(
        { err, toolsDir },
        "Failed to start workspace tools watcher — workspace tools will only register at startup",
      );
    }
  }

  stop(): void {
    this.debouncer.cancelAll();
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Chain `reconcileStem(stem)` after any in-flight reconcile for the
   * same stem so we never run two `loadSingleWorkspaceTool` calls
   * concurrently for the same name.
   */
  private scheduleReconcile(stem: string): void {
    const prev = this.inflight.get(stem) ?? Promise.resolve();
    const next = prev
      .catch(() => {
        /* swallow — error already logged in the prior tick */
      })
      .then(() => this.reconcileStem(stem))
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { err, stem },
          `workspace-tools-watcher: reconcile for "${stem}" threw: ${message}`,
        );
      })
      .finally(() => {
        // Only clear if we're still the current in-flight promise.
        if (this.inflight.get(stem) === next) {
          this.inflight.delete(stem);
        }
      });
    this.inflight.set(stem, next);
  }

  /**
   * Reconcile a single stem (= tool name) with on-disk state.
   *
   * Possible (live, removed) tuples and their resolution:
   *
   * - `(present, absent)` → ensure workspace tool is registered using
   *   the winning live file; re-import if a previous registration
   *   pointed at a different path
   * - `(absent, present)` → ensure core tool is stripped (and any
   *   previous workspace registration torn down first)
   * - `(absent, absent)` → ensure neither stripped state nor live
   *   registration remains
   * - `(present, present)` → ambiguous; tear down both so neither
   *   state survives (matches the initial-scan contract)
   */
  private async reconcileStem(stem: string): Promise<void> {
    const toolsDir = getWorkspaceToolsDir();
    if (!existsSync(toolsDir)) {
      this.teardownStem(stem);
      return;
    }

    const { livePath, hasRemovedSentinel } = findWinningWorkspaceToolPath(
      toolsDir,
      stem,
    );

    // Ambiguous: tear down everything for this stem.
    if (hasRemovedSentinel && livePath !== null) {
      log.error(
        { stem, toolsDir, livePath },
        `workspace-tools-watcher: "${stem}" has both a live file and a .removed sentinel — tearing down both`,
      );
      this.teardownStem(stem);
      return;
    }

    // Neither: tear down anything we own.
    if (!hasRemovedSentinel && livePath === null) {
      this.teardownStem(stem);
      return;
    }

    if (hasRemovedSentinel) {
      // Strip the core tool. Unregister any prior workspace registration
      // first so removeCoreToolViaWorkspace doesn't throw on the
      // workspace-owned-name check.
      if (getToolOwner(stem)?.kind === "workspace") {
        unregisterWorkspaceTool(stem);
      }
      try {
        removeCoreToolViaWorkspace(stem);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { err, stem },
          `workspace-tools-watcher: failed to strip "${stem}": ${message}`,
        );
      }
      return;
    }

    if (livePath !== null) {
      // If we previously stripped this core tool, restore it before the
      // workspace registration runs so the override path sees the
      // expected baseline (core tool present → stash + replace).
      if (getCoreToolOverride(stem) && !getTool(stem)) {
        restoreStrippedCoreTool(stem);
      }

      // If a workspace tool is already registered under this name,
      // unregister it so the loader can re-import cleanly. This covers
      // file-change events (same path, new contents) as well as
      // extension-precedence flips (e.g. user added foo.js next to
      // foo.ts — now .js wins and the registration must update).
      if (getToolOwner(stem)?.kind === "workspace") {
        unregisterWorkspaceTool(stem);
      }

      const registered = await loadSingleWorkspaceTool(livePath);
      if (registered) {
        log.info(
          { stem, livePath },
          `Workspace tool "${stem}" registered via watcher`,
        );
      }
      // loadSingleWorkspaceTool already logs failures with attribution.
    }
  }

  /**
   * Tear down any workspace-tool state we own for `stem`: unregister a
   * live workspace tool, restore a core tool we stripped. Both no-ops
   * when there's nothing to undo.
   */
  private teardownStem(stem: string): void {
    if (getToolOwner(stem)?.kind === "workspace") {
      unregisterWorkspaceTool(stem);
      log.info(
        { stem },
        `Workspace tool "${stem}" unregistered via watcher (file removed)`,
      );
    }
    if (getCoreToolOverride(stem) && !getTool(stem)) {
      restoreStrippedCoreTool(stem);
    }
  }

  // ── Test affordances ────────────────────────────────────────────────
  //
  // These are intentionally narrow — exposed for the watcher tests so
  // they can drive reconcile() deterministically without waiting on the
  // debouncer, and inspect whether an in-flight promise is settled.
  // Not part of the public lifecycle API.

  /**
   * Run a reconcile for `stem` synchronously (well, asynchronously, but
   * without going through the debouncer). For tests.
   */
  async _testReconcile(stem: string): Promise<void> {
    await this.reconcileStem(stem);
  }
}
