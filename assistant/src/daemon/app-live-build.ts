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
   * Refresh in-memory/persisted surfaces for the app. Returns the applied
   * reload generation so this orchestrator can keep one source of truth shared
   * with the broadcast event. When `reloadGeneration` is supplied the caller is
   * expected to use it verbatim.
   */
  refreshSurfaces: (
    appId: string,
    opts: {
      fileChange: true;
      compileStatus: "ok" | "error";
      buildErrors?: string[];
      reloadGeneration?: number;
    },
  ) => void;
  /** Notify the app-list / publish pipeline (existing side effects). */
  onSettled: () => void;
}

/**
 * Per-app reload generation counter — the single source of truth for the
 * `reloadGeneration` field shared by the broadcast event and the refreshed
 * surfaces. Bumped only on a successful recompile.
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
  // Snapshot the current generation for the non-bumping `building`/`error`
  // outcomes. The successful `ok` outcome instead reads-and-bumps the counter
  // AFTER the (serialized) compile resolves, so two overlapping builds that
  // both succeed produce two distinct, monotonically increasing generations.
  const generationAtStart = appReloadGenerations.get(appId) ?? 0;

  // Capture the last-good resolved html BEFORE compiling: compileApp begins
  // with `rm -rf dist/`, so on a failed compile the dist (and thus the
  // resolvable html) would otherwise be wiped.
  const lastGoodHtml = deps.resolveEffectiveAppHtml(app);

  // Settle a terminal outcome: refresh surfaces, broadcast the preview update,
  // and run the existing app-list/publish side effects.
  const emit = (
    update: Pick<
      AppPreviewUpdateEvent,
      "html" | "compileStatus" | "buildErrors" | "reloadGeneration"
    >,
  ) => {
    if (update.compileStatus !== "building") {
      deps.refreshSurfaces(appId, {
        fileChange: true,
        compileStatus: update.compileStatus,
        buildErrors: update.buildErrors,
        reloadGeneration: update.reloadGeneration,
      });
    }
    deps.broadcast({ type: "app_preview_update", appId, ...update });
    if (update.compileStatus !== "building") deps.onSettled();
  };

  // Show a building overlay immediately without blanking the preview.
  emit({
    html: lastGoodHtml,
    compileStatus: "building",
    reloadGeneration: generationAtStart,
  });

  let result: CompileResult;
  try {
    result = await deps.compileApp(appDir);
  } catch {
    // Treat a thrown compile as a failed compile: keep the last-good preview.
    emit({
      html: lastGoodHtml,
      compileStatus: "error",
      buildErrors: ["Recompile failed"],
      reloadGeneration: generationAtStart,
    });
    return;
  }

  if (result.ok) {
    // Read-and-bump AFTER the compile resolves so overlapping successful
    // builds each get a distinct, monotonically increasing generation. (Both
    // the read and the write happen synchronously here with no intervening
    // await, so they are atomic against other invocations.)
    const nextGeneration = (appReloadGenerations.get(appId) ?? 0) + 1;
    appReloadGenerations.set(appId, nextGeneration);
    emit({
      html: deps.resolveEffectiveAppHtml(app),
      compileStatus: "ok",
      reloadGeneration: nextGeneration,
    });
    return;
  }

  // Failed compile: do NOT push broken/placeholder html and do NOT bump the
  // reload generation. Re-broadcast the captured last-good html plus errors.
  emit({
    html: lastGoodHtml,
    compileStatus: "error",
    buildErrors: result.errors.map((e) => e.text),
    reloadGeneration: generationAtStart,
  });
}
