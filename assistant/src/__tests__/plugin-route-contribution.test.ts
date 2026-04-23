/**
 * Tests for plugin HTTP-route contributions (PR 32).
 *
 * A plugin may declare a `routes` array on its {@link Plugin} shape; after
 * `init()` succeeds, bootstrap wires each entry into the skill-route registry
 * via {@link registerSkillRoute}, retains the opaque {@link SkillRouteHandle}
 * it receives back, and on shutdown calls {@link unregisterSkillRoute} with
 * that exact handle. Handle-keyed unregistration ensures that two
 * owners (e.g. a plugin and a skill) that legitimately register the same
 * regex cannot have one owner's teardown silently evict another owner's
 * route, preserving the "no traffic hits a plugin handler during
 * onShutdown" invariant.
 *
 * The registry doesn't own HTTP itself — the tests here exercise:
 *
 *  1. Bootstrap → `registerSkillRoute` → `matchSkillRoute` returns the plugin's
 *     handler, and the handler responds as expected.
 *  2. Shutdown → `unregisterSkillRoute` drops the entry, and subsequent
 *     `matchSkillRoute` lookups return `null`.
 *  3. Plugins without `routes` (or with an empty array) bootstrap cleanly.
 *  4. When two plugins register regex patterns with identical `source+flags`,
 *     each plugin's shutdown only removes its own route — the other plugin's
 *     route stays live until its own teardown runs.
 *
 * Uses `mock.module` to stub credential resolution — bootstrap otherwise
 * tries to hit the real secure-key backend. `resetPluginRegistryForTests()`
 * isolates plugin-registry state and `resetSkillRoutesForTests()` isolates
 * skill-route-registry state between cases.
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
  resetSkillRoutesForTests,
  type SkillRoute,
  type SkillRouteMatch,
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

describe("plugin route contributions", () => {
  const echoPattern = /^\/_plugin\/echo$/;

  beforeEach(async () => {
    resetPluginRegistryForTests();
    resetSkillRoutesForTests();
    getSecureKeyAsyncMock.mockReset();
    getSecureKeyAsyncMock.mockImplementation(async () => undefined);
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

  test("shutdown tolerates a route whose registry entry was wiped externally", async () => {
    // Guard against the case where a stale handle no longer points at a live
    // registry entry (e.g. the registry was cleared externally). The shutdown
    // hook must not crash — unregisterSkillRoute returns false, and
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

    // Simulate an external wipe before the shutdown hook runs — e.g. a
    // different subsystem calling `resetSkillRoutesForTests` or a hot-reload
    // flow clearing the registry. The plugin's retained handle is now stale.
    resetSkillRoutesForTests();

    await runShutdownHooks("test-shutdown");

    // onShutdown still ran despite the stale handle — proving the
    // route-unregister step does not short-circuit plugin teardown.
    expect(shutdownFired).toBe(true);
  });

  test("shutdown of one plugin does not evict a sibling's same-pattern route", async () => {
    // Regression for the reviewer-flagged invariant: keying unregistration on
    // `pattern.source + flags` would let plugin-A's teardown drop plugin-B's
    // route when both declared regex with identical text. With handle-keyed
    // identity, each plugin's teardown removes only its own registrations.
    //
    // We simulate this by wiring two plugins that both contribute a route
    // matching `/^\/_plugin\/echo$/`. Teardown runs in reverse registration
    // order, so plugin-B is torn down first; plugin-A's route must still
    // match afterwards, and only disappear once plugin-A's own teardown
    // runs.
    let pluginAShutdown = false;
    let pluginBShutdown = false;
    // Capture the match result from inside plugin-B's onShutdown so assertions
    // run after runShutdownHooks returns. teardownPlugin wraps onShutdown in a
    // try/catch that swallows thrown assertion errors, so asserting inline
    // would let a failing match silently pass the test.
    let pluginBOnShutdownMatch: SkillRouteMatch | null = null;

    registerPlugin(
      buildPlugin("plugin-a", {
        routes: [
          {
            pattern: /^\/_plugin\/echo$/,
            methods: ["GET"],
            handler: async () => new Response("a", { status: 200 }),
          },
        ],
        async onShutdown() {
          // When plugin-A's teardown runs, plugin-B has already been torn
          // down — but plugin-A's route must still be live because
          // `onShutdown` fires *after* the route-unregister step for this
          // plugin but *before* it leaves teardownPlugin. We check liveness
          // from plugin-B's teardown instead (see below).
          pluginAShutdown = true;
        },
      }),
    );

    registerPlugin(
      buildPlugin("plugin-b", {
        routes: [
          {
            pattern: /^\/_plugin\/echo$/,
            methods: ["GET"],
            handler: async () => new Response("b", { status: 200 }),
          },
        ],
        async onShutdown() {
          // Plugin-B's routes have already been unregistered by the time
          // this fires, but plugin-A's route is still live — it only gets
          // torn down after this hook returns and the loop moves on to
          // plugin-A. Confirm the registry still has a matching route.
          pluginBShutdown = true;
          pluginBOnShutdownMatch = matchSkillRoute("/_plugin/echo", "GET");
        },
      }),
    );

    await bootstrapPlugins(fakeCtx);

    // Both plugins' routes landed in the registry; matching returns one of
    // them (order defined by registration, but we only care that *some*
    // route matches before shutdown starts).
    expect(matchSkillRoute("/_plugin/echo", "GET")).not.toBeNull();

    await runShutdownHooks("test-shutdown");

    expect(pluginBShutdown).toBe(true);
    expect(pluginAShutdown).toBe(true);
    expect(pluginBOnShutdownMatch).not.toBeNull();
    expect(pluginBOnShutdownMatch!.kind).toBe("match");

    // After both plugins shut down, no routes remain.
    expect(matchSkillRoute("/_plugin/echo", "GET")).toBeNull();
  });
});
