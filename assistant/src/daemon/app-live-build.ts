/**
 * Live-build orchestration for multifile app source changes.
 *
 * On every detected source-file change the daemon recompiles the app and
 * refreshes connected surfaces. This module owns the `app_preview_update`
 * broadcast contract that lets web hot-swap the preview iframe while the
 * assistant is still writing, while keeping the last-good preview on a
 * transient compile error.
 *
 * The orchestration is dependency-injected so it can be unit-tested without
 * standing up the full daemon server.
 */

import type { AppPreviewUpdateEvent } from "../api/events/app-preview-update.js";
import type { CompileResult } from "../bundler/app-compiler.js";
import type { AppDefinition } from "../memory/app-store.js";

export interface AppLiveBuildDeps {
  /** Compile the multifile app at `appDir`. Begins with `rm -rf dist/`. */
  compileApp: (appDir: string) => Promise<CompileResult>;
  /** Resolve the effective (inlined) preview html for the app's current dist. */
  resolveEffectiveAppHtml: (app: AppDefinition) => string;
  /** Broadcast an app_preview_update event to all connected clients. */
  broadcast: (msg: AppPreviewUpdateEvent) => void;
  /**
   * Refresh in-memory/persisted surfaces for the app. The per-surface
   * `reloadGeneration` is the single source of truth for the macOS reload, so
   * this returns the highest generation actually applied across surfaces.
   * `reloadGeneration` is a monotonic floor: each surface advances to at least
   * `floor` but never below `currentGeneration + 1`, so the broadcast can adopt
   * the returned value and stay in agreement with — and strictly ahead of —
   * what clients last saw.
   */
  refreshSurfaces: (
    appId: string,
    opts: {
      fileChange: true;
      compileStatus: "ok" | "error";
      buildErrors?: string[];
      reloadGeneration?: number;
    },
  ) => number;
  /** Notify the app-list / publish pipeline (existing side effects). */
  onSettled: () => void;
}

/**
 * Per-app reload generation counter for the `app_preview_update` broadcast.
 *
 * The per-surface counter (see `refreshSurfacesForApp`) is the authoritative
 * source of truth for the macOS change-detection reload; this map mirrors the
 * highest generation applied to any surface so overlapping live builds keep
 * issuing strictly increasing broadcast generations even when no surface is
 * currently mounted. It is reconciled from `refreshSurfaces`' return value on
 * every successful recompile, so it can never collide with or regress below
 * what a client last saw.
 */
const appReloadGenerations = new Map<string, number>();

/** Test-only reset of the generation counters. */
export function __resetAppReloadGenerations(): void {
  appReloadGenerations.clear();
}

/**
 * Recompile a multifile app on source change and broadcast its live-build
 * status, keeping the last-good preview on compile failure.
 */
export async function runAppLiveBuild(
  appId: string,
  app: AppDefinition,
  appDir: string,
  deps: AppLiveBuildDeps,
): Promise<void> {
  // The non-bumping `building`/`error` outcomes never advance the counter;
  // they re-broadcast whatever generation a client already has. We read this
  // CURRENT generation at settle time (not an invocation-time snapshot): when
  // a source change queues behind an in-flight rebuild that later succeeds and
  // bumps the generation, a subsequent error for the queued build must report
  // the now-current (higher) generation. Reporting a stale pre-bump snapshot
  // would put the error's `reloadGeneration` below the last applied `ok`, and
  // the web store's stale-event guard drops such non-`ok` events — hiding the
  // compile error while the preview looks healthy.
  const currentGeneration = () => appReloadGenerations.get(appId) ?? 0;

  // Capture the last-good resolved html BEFORE compiling: compileApp begins
  // with `rm -rf dist/`, so on a failed compile the dist (and thus the
  // resolvable html) would otherwise be wiped.
  const lastGoodHtml = deps.resolveEffectiveAppHtml(app);

  // Broadcast the preview update and run the existing app-list/publish side
  // effects. Surface refresh (the source of the reload generation) happens in
  // the caller for the `ok` path, since its applied generation feeds the
  // broadcast; the non-bumping `error` path refreshes here.
  const broadcastUpdate = (
    update: Pick<
      AppPreviewUpdateEvent,
      "html" | "compileStatus" | "buildErrors" | "reloadGeneration"
    >,
  ) => {
    deps.broadcast({ type: "app_preview_update", appId, ...update });
    if (update.compileStatus !== "building") deps.onSettled();
  };

  // Signal that a rebuild is in flight while keeping the last-good preview
  // visible. No surface refresh: a building status must not bump the reload
  // generation.
  broadcastUpdate({
    html: lastGoodHtml,
    compileStatus: "building",
    reloadGeneration: currentGeneration(),
  });

  const settleError = (buildErrors: string[]) => {
    // Failed compile: do NOT push broken/placeholder html and do NOT bump the
    // reload generation. Re-broadcast the captured last-good html plus errors.
    deps.refreshSurfaces(appId, {
      fileChange: true,
      compileStatus: "error",
      buildErrors,
    });
    // Report the CURRENT generation (read at settle time, after any
    // interleaved successful build bumped it) so the web stale-guard does not
    // drop this error. The error itself still does NOT bump the counter —
    // this is keep-last-good, not a new good frame.
    broadcastUpdate({
      html: lastGoodHtml,
      compileStatus: "error",
      buildErrors,
      reloadGeneration: currentGeneration(),
    });
  };

  let result: CompileResult;
  try {
    result = await deps.compileApp(appDir);
  } catch {
    // Treat a thrown compile as a failed compile: keep the last-good preview.
    settleError(["Recompile failed"]);
    return;
  }

  if (result.ok) {
    // Let the surface refresh advance the authoritative per-surface counter and
    // tell us the generation it applied. We pass the module counter + 1 as a
    // monotonic floor and adopt the returned value (which is also >= every
    // surface's prior generation + 1), so the broadcast can never collide with
    // or regress below what a client last saw, even across overlapping builds.
    // The read-and-write of the module counter is synchronous (no intervening
    // await), so it is atomic against other in-flight invocations.
    const floor = (appReloadGenerations.get(appId) ?? 0) + 1;
    const appliedGeneration = deps.refreshSurfaces(appId, {
      fileChange: true,
      compileStatus: "ok",
      reloadGeneration: floor,
    });
    const nextGeneration = Math.max(floor, appliedGeneration);
    appReloadGenerations.set(appId, nextGeneration);
    broadcastUpdate({
      html: deps.resolveEffectiveAppHtml(app),
      compileStatus: "ok",
      reloadGeneration: nextGeneration,
    });
    return;
  }

  settleError(result.errors.map((e) => e.text));
}
