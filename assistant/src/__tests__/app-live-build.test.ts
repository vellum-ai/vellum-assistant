/**
 * Tests for the live-build orchestration that emits `app_preview_update`
 * events on multifile app source changes, keeping the last-good preview on a
 * transient compile failure.
 *
 * Exercises `runAppLiveBuild` directly via dependency injection so it does not
 * stand up the full daemon server.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { AppPreviewUpdateEvent } from "../api/events/app-preview-update.js";
import type { CompileResult } from "../bundler/app-compiler.js";
import {
  __resetAppReloadGenerations,
  type AppLiveBuildDeps,
  runAppLiveBuild,
} from "../daemon/app-live-build.js";
import type { AppDefinition } from "../memory/app-store.js";

const APP_ID = "app-live-1";
const LAST_GOOD_HTML = "<html>last-good</html>";
const FRESH_HTML = "<html>fresh</html>";

const fakeApp = { id: APP_ID } as unknown as AppDefinition;

interface Harness {
  deps: AppLiveBuildDeps;
  settledCount: () => number;
}

/**
 * Default `refreshSurfaces` stub: models the real surface counter as the
 * single source of truth. Tracks a per-app generation and, on a successful
 * recompile, advances it to at least the supplied floor (`max(floor, gen + 1)`)
 * and returns it. A failed compile does not bump and returns the current value.
 */
function makeSurfaceCounter() {
  const generations = new Map<string, number>();
  const refreshSurfaces: AppLiveBuildDeps["refreshSurfaces"] = (id, opts) => {
    const current = generations.get(id) ?? 0;
    if (opts.compileStatus === "error") return current;
    const next = Math.max(opts.reloadGeneration ?? 0, current + 1);
    generations.set(id, next);
    return next;
  };
  return { refreshSurfaces, peek: (id: string) => generations.get(id) ?? 0 };
}

function makeHarness(opts: { compile: () => Promise<CompileResult> }): Harness {
  let settled = 0;
  const deps: AppLiveBuildDeps = {
    compileApp: opts.compile,
    resolveEffectiveAppHtml: () => LAST_GOOD_HTML,
    broadcast: () => {},
    refreshSurfaces: makeSurfaceCounter().refreshSurfaces,
    onSettled: () => {
      settled++;
    },
  };
  return { deps, settledCount: () => settled };
}

function ok(): CompileResult {
  return { ok: true, errors: [], warnings: [], durationMs: 1 };
}

function fail(messages: string[]): CompileResult {
  return {
    ok: false,
    errors: messages.map((text) => ({ text })),
    warnings: [],
    durationMs: 1,
  };
}

describe("runAppLiveBuild", () => {
  beforeEach(() => {
    __resetAppReloadGenerations();
  });

  test("clean compile broadcasts building then ok with a bumped reloadGeneration", async () => {
    let distFresh = false;
    const compile = async () => {
      distFresh = true;
      return ok();
    };
    const broadcasts: AppPreviewUpdateEvent[] = [];
    const refreshCalls: Array<
      Parameters<AppLiveBuildDeps["refreshSurfaces"]>[1]
    > = [];
    const surface = makeSurfaceCounter();
    const deps: AppLiveBuildDeps = {
      compileApp: compile,
      resolveEffectiveAppHtml: () => (distFresh ? FRESH_HTML : LAST_GOOD_HTML),
      broadcast: (msg) => broadcasts.push(msg),
      refreshSurfaces: (id, o) => {
        refreshCalls.push(o);
        return surface.refreshSurfaces(id, o);
      },
      onSettled: () => {},
    };

    await runAppLiveBuild(APP_ID, fakeApp, "/tmp/app", deps);

    expect(broadcasts.map((b) => b.compileStatus)).toEqual(["building", "ok"]);

    const building = broadcasts[0];
    expect(building.html).toBe(LAST_GOOD_HTML);
    expect(building.reloadGeneration).toBe(0);

    const okMsg = broadcasts[1];
    expect(okMsg.html).toBe(FRESH_HTML);
    expect(okMsg.reloadGeneration).toBe(1); // bumped
    expect(okMsg.buildErrors).toBeUndefined();

    // Only the terminal `ok` outcome refreshes surfaces; the broadcast
    // generation equals the one the surface applied.
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0].compileStatus).toBe("ok");
    expect(okMsg.reloadGeneration).toBe(surface.peek(APP_ID));
  });

  test("failed compile keeps last-good html and an unchanged reloadGeneration", async () => {
    const surface = makeSurfaceCounter();
    // First do a clean build to advance the generation to 1.
    {
      const compile = async () => ok();
      const broadcasts: AppPreviewUpdateEvent[] = [];
      const deps: AppLiveBuildDeps = {
        compileApp: compile,
        resolveEffectiveAppHtml: () => FRESH_HTML,
        broadcast: (msg) => broadcasts.push(msg),
        refreshSurfaces: surface.refreshSurfaces,
        onSettled: () => {},
      };
      await runAppLiveBuild(APP_ID, fakeApp, "/tmp/app", deps);
      expect(broadcasts[1].reloadGeneration).toBe(1);
    }

    // Now a failing compile. `resolveEffectiveAppHtml` would return the
    // placeholder after `rm -rf dist/`, but the orchestrator must have
    // captured the last-good html BEFORE compiling.
    const broadcasts: AppPreviewUpdateEvent[] = [];
    const refreshCalls: Array<
      Parameters<AppLiveBuildDeps["refreshSurfaces"]>[1]
    > = [];
    let compiled = false;
    const deps: AppLiveBuildDeps = {
      compileApp: async () => {
        compiled = true; // simulate `rm -rf dist/` wiping dist
        return fail(["Could not resolve 'foo'", "Unexpected token"]);
      },
      // After dist is wiped, html resolution degrades to a placeholder.
      resolveEffectiveAppHtml: () =>
        compiled ? "<p>App compilation failed.</p>" : LAST_GOOD_HTML,
      broadcast: (msg) => broadcasts.push(msg),
      refreshSurfaces: (id, o) => {
        refreshCalls.push(o);
        return surface.refreshSurfaces(id, o);
      },
      onSettled: () => {},
    };

    await runAppLiveBuild(APP_ID, fakeApp, "/tmp/app", deps);

    expect(broadcasts.map((b) => b.compileStatus)).toEqual([
      "building",
      "error",
    ]);

    const errMsg = broadcasts[1];
    expect(errMsg.compileStatus).toBe("error");
    // Last-good html, NOT the post-rm placeholder.
    expect(errMsg.html).toBe(LAST_GOOD_HTML);
    expect(errMsg.buildErrors).toEqual([
      "Could not resolve 'foo'",
      "Unexpected token",
    ]);
    // reloadGeneration unchanged (still 1 from the prior clean build).
    expect(errMsg.reloadGeneration).toBe(1);

    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0].compileStatus).toBe("error");
    // The error path does not pass a generation floor; the surface owns its
    // (unchanged) generation on a failed compile.
    expect(refreshCalls[0].reloadGeneration).toBeUndefined();
    expect(refreshCalls[0].buildErrors).toEqual([
      "Could not resolve 'foo'",
      "Unexpected token",
    ]);
  });

  test("thrown compile is treated as a failure that keeps last-good preview", async () => {
    const broadcasts: AppPreviewUpdateEvent[] = [];
    const deps: AppLiveBuildDeps = {
      compileApp: async () => {
        throw new Error("boom");
      },
      resolveEffectiveAppHtml: () => LAST_GOOD_HTML,
      broadcast: (msg) => broadcasts.push(msg),
      refreshSurfaces: makeSurfaceCounter().refreshSurfaces,
      onSettled: () => {},
    };

    await runAppLiveBuild(APP_ID, fakeApp, "/tmp/app", deps);

    expect(broadcasts.map((b) => b.compileStatus)).toEqual([
      "building",
      "error",
    ]);
    expect(broadcasts[1].html).toBe(LAST_GOOD_HTML);
    expect(broadcasts[1].reloadGeneration).toBe(0);
  });

  test("two overlapping successful compiles yield distinct increasing generations", async () => {
    // Both invocations are in-flight at once. The generation is read-and-bumped
    // (through the shared surface counter) AFTER each compile succeeds, so the
    // second successful build cannot reuse the first's reloadGeneration —
    // otherwise the macOS change-detection would drop the latest output.
    const okBroadcasts: AppPreviewUpdateEvent[] = [];
    const okRefreshGenerations: number[] = [];
    // A single surface counter shared by both invocations, as in production.
    const surface = makeSurfaceCounter();

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let firstStarted!: () => void;
    const firstStartedGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    let compileCount = 0;
    const deps: AppLiveBuildDeps = {
      // First compile blocks until both invocations are in-flight, so they
      // overlap before either advances the generation.
      compileApp: async () => {
        compileCount += 1;
        if (compileCount === 1) {
          firstStarted();
          await firstGate;
        }
        return ok();
      },
      resolveEffectiveAppHtml: () => FRESH_HTML,
      broadcast: (msg) => {
        if (msg.compileStatus === "ok") okBroadcasts.push(msg);
      },
      refreshSurfaces: (id, o) => {
        const applied = surface.refreshSurfaces(id, o);
        if (o.compileStatus === "ok") okRefreshGenerations.push(applied);
        return applied;
      },
      onSettled: () => {},
    };

    const first = runAppLiveBuild(APP_ID, fakeApp, "/tmp/app", deps);
    await firstStartedGate;
    // Second invocation starts while the first is still awaiting its compile.
    const second = runAppLiveBuild(APP_ID, fakeApp, "/tmp/app", deps);
    releaseFirst();
    await Promise.all([first, second]);

    const generations = okBroadcasts
      .map((b) => b.reloadGeneration)
      .sort((a, b) => a - b);
    expect(generations).toEqual([1, 2]);
    // Broadcast generations match the ones written to surfaces.
    expect([...okRefreshGenerations].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  test("first live-build after an app_create surface bump does not collide", async () => {
    // Reproduces the Gap-1 collision: `app_create` bumped the surface to 1
    // (via the non-live-build +1 path) while the live-build module counter is
    // still 0. The first successful live-build must NOT reuse generation 1 —
    // the macOS client uses change-detection (gen != lastGen), so reusing the
    // value it already saw would suppress a legitimate reload.
    const surface = makeSurfaceCounter();
    // Simulate the app_create surface bump (no live-build floor → +1 to 1).
    expect(
      surface.refreshSurfaces(APP_ID, {
        fileChange: true,
        // Cast: app_create/app_refresh path has no compileStatus, modeled here
        // as a non-error bump.
        compileStatus: "ok",
      } as Parameters<AppLiveBuildDeps["refreshSurfaces"]>[1]),
    ).toBe(1);

    const okBroadcasts: AppPreviewUpdateEvent[] = [];
    const deps: AppLiveBuildDeps = {
      compileApp: async () => ok(),
      resolveEffectiveAppHtml: () => FRESH_HTML,
      broadcast: (msg) => {
        if (msg.compileStatus === "ok") okBroadcasts.push(msg);
      },
      refreshSurfaces: surface.refreshSurfaces,
      onSettled: () => {},
    };

    await runAppLiveBuild(APP_ID, fakeApp, "/tmp/app", deps);

    expect(okBroadcasts).toHaveLength(1);
    // Strictly greater than the 1 the surface (and client) already had.
    expect(okBroadcasts[0].reloadGeneration).toBeGreaterThan(1);
    // Broadcast equals the surface's current generation (single source).
    expect(okBroadcasts[0].reloadGeneration).toBe(surface.peek(APP_ID));
  });

  test("settle/onSettled fires on every outcome", async () => {
    const h = makeHarness({ compile: async () => ok() });
    await runAppLiveBuild(APP_ID, fakeApp, "/tmp/app", h.deps);
    expect(h.settledCount()).toBe(1);

    const h2 = makeHarness({ compile: async () => fail(["x"]) });
    await runAppLiveBuild(APP_ID, fakeApp, "/tmp/app", h2.deps);
    expect(h2.settledCount()).toBe(1);
  });
});
