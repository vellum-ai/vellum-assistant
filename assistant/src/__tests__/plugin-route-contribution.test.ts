/**
 * Tests for plugin HTTP-route contributions (PR 32).
 *
 * A plugin may declare a `routes` array on its {@link Plugin} shape; after
 * `init()` succeeds, bootstrap wires each entry into the skill-route registry
 * via {@link registerSkillRoute} so the runtime HTTP server can dispatch to
 * the plugin's handler. On shutdown, {@link unregisterSkillRoute} removes the
 * same entries so a teardown leaves no dangling surface behind.
 *
 * The registry doesn't own HTTP itself — the tests here exercise:
 *
 *  1. Bootstrap → `registerSkillRoute` → `matchSkillRoute` returns the plugin's
 *     handler, and the handler responds as expected.
 *  2. Shutdown → `unregisterSkillRoute` drops the entry, and subsequent
 *     `matchSkillRoute` lookups return `null`.
 *  3. Plugins without `routes` (or with an empty array) bootstrap cleanly.
 *  4. `unregisterSkillRoute` accepts either the original pattern instance or
 *     an equivalent regex, so plugins that reconstruct the pattern at
 *     shutdown time still succeed.
 *
 * Uses `mock.module` to stub credential resolution — bootstrap otherwise
 * tries to hit the real secure-key backend. `resetPluginRegistryForTests()`
 * isolates registry state between cases, and the skill-route registry is
 * swept via best-effort `unregisterSkillRoute` calls in `beforeEach`.
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the credential store before importing bootstrap so the module binds to
// the mock. Plugins in these tests don't declare `requiresCredential`, but
// the mock keeps the test hermetic regardless of what the backend would do.
const getSecureKeyAsyncMock = mock(
  async (_account: string): Promise<string | undefined> => undefined,
);
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: getSecureKeyAsyncMock,
}));

import type { AssistantConfig } from "../config/schema.js";
import {
  bootstrapPlugins,
  type DaemonContext,
} from "../daemon/external-plugins-bootstrap.js";
import { runShutdownHooks } from "../daemon/shutdown-registry.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { Plugin } from "../plugins/types.js";
import {
  matchSkillRoute,
  type SkillRoute,
  unregisterSkillRoute,
} from "../runtime/skill-route-registry.js";

// Redirect plugin storage creation into a per-process temp tree so the test
// never touches a developer's real ~/.vellum.
const TEST_INSTANCE_DIR = join(
  tmpdir(),
  `vellum-plugin-route-contrib-test-${process.pid}`,
);
process.env.BASE_DATA_DIR = TEST_INSTANCE_DIR;

const fakeConfig = {} as unknown as AssistantConfig;
const fakeCtx: DaemonContext = {
  config: fakeConfig,
  assistantVersion: "9.9.9-test",
};

/** Build a minimal valid plugin with optional route contributions. */
function buildPlugin(
  name: string,
  extras: Partial<Omit<Plugin, "manifest">> = {},
): Plugin {
  return {
    manifest: {
      name,
      version: "0.0.1",
      requires: { pluginRuntime: "v1" },
    },
    ...extras,
  };
}

/**
 * Best-effort sweep — unregister every known test route so a prior failing
 * case cannot leak state into the next. `unregisterSkillRoute` is idempotent
 * (returns `false` for unknown patterns without throwing), so attempting to
 * drop a pattern that was never registered is safe.
 */
function clearTestRoutes(patterns: RegExp[]): void {
  for (const pattern of patterns) {
    unregisterSkillRoute(pattern);
  }
}

describe("plugin route contributions", () => {
  const echoPattern = /^\/_plugin\/echo$/;
  const otherPattern = /^\/_plugin\/other$/;

  beforeEach(async () => {
    resetPluginRegistryForTests();
    getSecureKeyAsyncMock.mockReset();
    getSecureKeyAsyncMock.mockImplementation(async () => undefined);
    clearTestRoutes([echoPattern, otherPattern]);
    await rm(TEST_INSTANCE_DIR, { recursive: true, force: true });
  });

  test("bootstrap registers a plugin's routes and the HTTP handler responds", async () => {
    let initFired = false;
    const route: SkillRoute = {
      pattern: echoPattern,
      methods: ["GET"],
      handler: async () =>
        new Response("echo", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    };

    registerPlugin(
      buildPlugin("echo-plugin", {
        async init() {
          initFired = true;
        },
        routes: [route],
      }),
    );

    await bootstrapPlugins(fakeCtx);

    // init() must have run — route registration is gated on init success.
    expect(initFired).toBe(true);

    // matchSkillRoute resolves against the same registry the HTTP server
    // hits at request dispatch time, so a match here proves the plugin's
    // handler is reachable from production code paths.
    const matched = matchSkillRoute("/_plugin/echo", "GET");
    expect(matched).not.toBeNull();
    expect(matched!.kind).toBe("match");

    // Invoke the handler through the matched record to prove the response
    // actually comes from the plugin — not some default.
    if (matched!.kind !== "match") throw new Error("unreachable");
    const req = new Request("http://host/_plugin/echo");
    const res = await matched!.route.handler(req, matched!.match);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("echo");
  });

  test("shutdown unregisters the plugin's routes", async () => {
    const route: SkillRoute = {
      pattern: echoPattern,
      methods: ["GET"],
      handler: async () => new Response("echo", { status: 200 }),
    };

    registerPlugin(buildPlugin("echo-plugin", { routes: [route] }));

    await bootstrapPlugins(fakeCtx);

    // Sanity: route is live after bootstrap.
    expect(matchSkillRoute("/_plugin/echo", "GET")).not.toBeNull();

    // Shutdown runs the reverse-order teardown hook registered by bootstrap.
    await runShutdownHooks("test-shutdown");

    // Route is gone — matchSkillRoute returns null because no pattern
    // matches the path at all anymore.
    expect(matchSkillRoute("/_plugin/echo", "GET")).toBeNull();
  });

  test("plugin with no routes bootstraps and shuts down cleanly", async () => {
    // Declaring no `routes` field is the common case; bootstrap must skip
    // route handling entirely (the guard is `if plugin.routes && length > 0`).
    registerPlugin(buildPlugin("no-routes-plugin", { async init() {} }));

    await bootstrapPlugins(fakeCtx);
    await runShutdownHooks("test-shutdown");

    // Nothing to verify beyond "neither throws" — an empty `routes` must not
    // regress existing no-op bootstrap semantics.
    expect(true).toBe(true);
  });

  test("shutdown tolerates a route that was externally removed mid-flight", async () => {
    // Guard against the case where a stale pattern no longer matches anything
    // in the registry (e.g. the registry was cleared externally). The
    // shutdown hook must not crash — unregisterSkillRoute returns false, and
    // bootstrap's try/catch around the call swallows the signal. This
    // exercises the defensive path so a partial-crash recovery still runs
    // every plugin's onShutdown in reverse order.
    let shutdownFired = false;
    registerPlugin(
      buildPlugin("echo-plugin", {
        routes: [
          {
            pattern: echoPattern,
            methods: ["GET"],
            handler: async () => new Response("echo", { status: 200 }),
          },
        ],
        async onShutdown() {
          shutdownFired = true;
        },
      }),
    );

    await bootstrapPlugins(fakeCtx);

    // External removal before the shutdown hook runs.
    expect(unregisterSkillRoute(echoPattern)).toBe(true);

    await runShutdownHooks("test-shutdown");

    // onShutdown still ran despite the stale route reference — proving the
    // route-unregister step does not short-circuit plugin teardown.
    expect(shutdownFired).toBe(true);
  });

  test("unregisterSkillRoute matches equivalent patterns (source + flags)", async () => {
    // Plugins that reconstruct their regex at shutdown time (e.g. after
    // reloading the manifest) must still land on the same registry slot.
    // Identity-first matching with a source+flags fallback keeps the common
    // case fast while tolerating the reconstruction pattern.
    const pattern1 = /^\/_plugin\/echo$/;
    const pattern2 = /^\/_plugin\/echo$/;
    expect(pattern1).not.toBe(pattern2); // different instances

    const route: SkillRoute = {
      pattern: pattern1,
      methods: ["GET"],
      handler: async () => new Response("ok", { status: 200 }),
    };

    registerPlugin(buildPlugin("echo-plugin", { routes: [route] }));

    await bootstrapPlugins(fakeCtx);
    expect(matchSkillRoute("/_plugin/echo", "GET")).not.toBeNull();

    // Unregister with a DIFFERENT RegExp instance having the same source.
    expect(unregisterSkillRoute(pattern2)).toBe(true);
    expect(matchSkillRoute("/_plugin/echo", "GET")).toBeNull();

    // A second call with the equivalent pattern finds nothing — the single
    // matching entry has already been removed.
    expect(unregisterSkillRoute(pattern2)).toBe(false);
  });
});
