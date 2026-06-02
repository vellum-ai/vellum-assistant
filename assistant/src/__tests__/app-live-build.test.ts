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

function makeHarness(opts: { compile: () => Promise<CompileResult> }): Harness {
  let settled = 0;
  const deps: AppLiveBuildDeps = {
    compileApp: opts.compile,
    resolveEffectiveAppHtml: () => LAST_GOOD_HTML,
    broadcast: () => {},
    refreshSurfaces: () => {},
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
    const deps: AppLiveBuildDeps = {
      compileApp: compile,
      resolveEffectiveAppHtml: () => (distFresh ? FRESH_HTML : LAST_GOOD_HTML),
      broadcast: (msg) => broadcasts.push(msg),
      refreshSurfaces: (_id, o) => refreshCalls.push(o),
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

    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0].compileStatus).toBe("ok");
    expect(refreshCalls[0].reloadGeneration).toBe(1);
  });

  test("failed compile keeps last-good html and an unchanged reloadGeneration", async () => {
    // First do a clean build to advance the generation to 1.
    {
      const compile = async () => ok();
      const broadcasts: AppPreviewUpdateEvent[] = [];
      const deps: AppLiveBuildDeps = {
        compileApp: compile,
        resolveEffectiveAppHtml: () => FRESH_HTML,
        broadcast: (msg) => broadcasts.push(msg),
        refreshSurfaces: () => {},
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
      refreshSurfaces: (_id, o) => refreshCalls.push(o),
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
    expect(refreshCalls[0].reloadGeneration).toBe(1);
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
      refreshSurfaces: () => {},
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
    // Both invocations capture the same starting generation BEFORE awaiting
    // their (serialized) compile. The generation must be read-and-bumped AFTER
    // each compile succeeds so the second successful build does not reuse the
    // first's reloadGeneration — otherwise clients drop the latest output.
    const okBroadcasts: AppPreviewUpdateEvent[] = [];
    const okRefreshGenerations: number[] = [];

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
      // First compile blocks until both invocations are in-flight, so they both
      // captured the same starting generation before either bumps it.
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
      refreshSurfaces: (_id, o) => {
        if (o.reloadGeneration !== undefined)
          okRefreshGenerations.push(o.reloadGeneration);
      },
      onSettled: () => {},
    };

    const first = runAppLiveBuild(APP_ID, fakeApp, "/tmp/app", deps);
    await firstStartedGate;
    // Second invocation starts (and snapshots the same generation) while the
    // first is still awaiting its compile.
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

  test("settle/onSettled fires on every outcome", async () => {
    const h = makeHarness({ compile: async () => ok() });
    await runAppLiveBuild(APP_ID, fakeApp, "/tmp/app", h.deps);
    expect(h.settledCount()).toBe(1);

    const h2 = makeHarness({ compile: async () => fail(["x"]) });
    await runAppLiveBuild(APP_ID, fakeApp, "/tmp/app", h2.deps);
    expect(h2.settledCount()).toBe(1);
  });
});
