/**
 * Tests for plugin HTTP-route contributions (PR 32).
 *
 * A plugin may declare a `routes` array on its {@link Plugin} shape; after
 * `init()` succeeds, bootstrap wires each entry into the skill-route registry
 * via {@link registerSkillRoute}, retains the opaque {@link SkillRouteHandle}
 * it receives back, and on shutdown the reverse-order surface-teardown closure
 * calls {@link unregisterSkillRoute} with that exact handle. Handle-keyed
 * unregistration ensures that two owners (e.g. a plugin and a skill) that
 * legitimately register the same regex cannot have one owner's teardown
 * silently evict another owner's route. Plugin `shutdown` hooks then fire
 * through the unified `runHook(HOOKS.SHUTDOWN, …)` pipeline once every surface
 * is unregistered, preserving the "no traffic hits a plugin handler during
 * onShutdown" invariant.
 *
 * The registry doesn't own HTTP itself — the tests here exercise:
 *
 *  1. Bootstrap → `registerSkillRoute` → `matchSkillRoute` returns the plugin's
 *     handler, and the handler responds as expected.
 *  2. Shutdown → `unregisterSkillRoute` drops the entry, and subsequent
 *     `matchSkillRoute` lookups return `null`.
 *  3. Plugins without `routes` (or with an empty array) bootstrap cleanly.
 *  4. Handle-keyed unregistration: unregistering one route's handle leaves a
 *     sibling's identical-pattern route live until its own handle is dropped.
 *
 * `resetPluginRegistryForTests()` isolates plugin-registry state and
 * `resetSkillRoutesForTests()` isolates skill-route-registry state between
 * cases.
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { bootstrapPlugins } from "../daemon/external-plugins-bootstrap.js";
import { runShutdownHooks } from "../daemon/shutdown-registry.js";
import { HOOKS } from "../plugin-api/constants.js";
import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { InitContext, Plugin } from "../plugins/types.js";
import {
  matchSkillRoute,
  registerSkillRoute,
  resetSkillRoutesForTests,
  type SkillRoute,
  type SkillRouteMatch,
  unregisterSkillRoute,
} from "../runtime/skill-route-registry.js";

// Redirect plugin storage creation into a per-process temp tree so the test
// never touches a developer's real ~/.vellum.
const TEST_WORKSPACE_DIR = join(
  tmpdir(),
  `vellum-plugin-route-contrib-test-${process.pid}`,
);
process.env.VELLUM_WORKSPACE_DIR = TEST_WORKSPACE_DIR;

/** Build a minimal valid plugin with optional route contributions. */
/**
 * Test helper. Accepts the new `hooks` bag and ALSO legacy top-level
 * `init` / `onShutdown` for ergonomics — the helper merges them into a
 * single `hooks` field that matches the runtime Plugin shape.
 */
function buildPlugin(
  name: string,
  extras: Partial<Omit<Plugin, "manifest" | "hooks">> & {
    hooks?: Plugin["hooks"];
    init?: (ctx: InitContext) => Promise<void>;
    onShutdown?: () => Promise<void>;
  } = {},
): Plugin {
  const {
    init: legacyInit,
    onShutdown: legacyOnShutdown,
    hooks: explicitHooks,
    ...rest
  } = extras;
  const mergedHooks: Plugin["hooks"] | undefined =
    legacyInit !== undefined ||
    legacyOnShutdown !== undefined ||
    explicitHooks !== undefined
      ? {
          ...(explicitHooks ?? {}),
          ...(legacyInit !== undefined ? { init: legacyInit } : {}),
          ...(legacyOnShutdown !== undefined
            ? { shutdown: legacyOnShutdown }
            : {}),
        }
      : undefined;
  return {
    manifest: {
      name,
      version: "0.0.1",
    },
    ...rest,
    ...(mergedHooks ? { hooks: mergedHooks } : {}),
  };
}

describe("plugin route contributions", () => {
  const echoPattern = /^\/_plugin\/echo$/;

  beforeEach(async () => {
    resetPluginRegistryForTests();
    resetSkillRoutesForTests();
    await rm(TEST_WORKSPACE_DIR, { recursive: true, force: true });
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

    await bootstrapPlugins();

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

    await bootstrapPlugins();

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

    await bootstrapPlugins();
    await runShutdownHooks("test-shutdown");

    // Nothing to verify beyond "neither throws" — an empty `routes` must not
    // regress existing no-op bootstrap semantics.
    expect(true).toBe(true);
  });

  test("shutdown tolerates a route whose registry entry was wiped externally", async () => {
    // Guard against the case where a stale handle no longer points at a live
    // registry entry (e.g. the registry was cleared externally). The surface
    // teardown must not crash — `unregisterSkillRoute` returns false and the
    // closure's try/catch swallows the signal — so the subsequent `runHook`
    // pipeline still fires the plugin's `shutdown` hook.
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

    await bootstrapPlugins();

    // Simulate an external wipe before teardown runs — e.g. a different
    // subsystem calling `resetSkillRoutesForTests` or a hot-reload flow
    // clearing the registry. The plugin's retained handle is now stale.
    resetSkillRoutesForTests();

    // Surface teardown survives the stale handle without throwing...
    await runShutdownHooks("test-shutdown");
    // ...and the plugin's `shutdown` hook still fires through the pipeline.
    await runHook(HOOKS.SHUTDOWN, { assistantVersion: "test" });

    expect(shutdownFired).toBe(true);
  });

  test("unregistering one route handle leaves a sibling's identical-pattern route live", async () => {
    // Regression for the reviewer-flagged invariant: keying unregistration on
    // `pattern.source + flags` would let one owner's teardown drop another
    // owner's route when both declared regex with identical text. The plugin
    // shutdown closure unregisters routes by the opaque handle retained at
    // registration time (`unregisterSkillRoute(handle)`), so that is the
    // mechanism keeping sibling routes intact. Exercise it directly: two
    // routes with byte-identical patterns, drop one handle, and the other must
    // still match until its own handle is dropped too.
    const handleA = registerSkillRoute({
      pattern: /^\/_plugin\/echo$/,
      methods: ["GET"],
      handler: async () => new Response("a", { status: 200 }),
    });
    const handleB = registerSkillRoute({
      pattern: /^\/_plugin\/echo$/,
      methods: ["GET"],
      handler: async () => new Response("b", { status: 200 }),
    });

    expect(matchSkillRoute("/_plugin/echo", "GET")).not.toBeNull();

    // Drop B (reverse-order teardown drops the last-registered owner first).
    expect(unregisterSkillRoute(handleB)).toBe(true);
    // A's identical-pattern route must still be live.
    expect(matchSkillRoute("/_plugin/echo", "GET")).not.toBeNull();

    // Only once A's own handle is dropped does the route disappear.
    expect(unregisterSkillRoute(handleA)).toBe(true);
    expect(matchSkillRoute("/_plugin/echo", "GET")).toBeNull();
  });

  test("every contributing plugin's shutdown hook fires through the pipeline after its surfaces are gone", async () => {
    // The daemon shutdown sequence unregisters all plugin surfaces (reverse
    // order, via the shutdown-registry closure) and then dispatches `shutdown`
    // hooks through the unified `runHook` pipeline — so by the time any
    // plugin's hook runs, its routes are already unregistered. Two plugins with
    // identical patterns prove both hooks fire and that the registry is empty
    // by hook time.
    const pluginsThatShutDown: string[] = [];
    let matchAtHookTime: SkillRouteMatch | null = null;

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
          pluginsThatShutDown.push("plugin-a");
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
          pluginsThatShutDown.push("plugin-b");
          // Surfaces are already unregistered by the time any hook runs.
          matchAtHookTime = matchSkillRoute("/_plugin/echo", "GET");
        },
      }),
    );

    await bootstrapPlugins();
    expect(matchSkillRoute("/_plugin/echo", "GET")).not.toBeNull();

    // Surface teardown first, then the pipeline fires the shutdown hooks.
    await runShutdownHooks("test-shutdown");
    await runHook(HOOKS.SHUTDOWN, { assistantVersion: "test" });

    // Both plugins' hooks fired exactly once.
    expect(pluginsThatShutDown.sort()).toEqual(["plugin-a", "plugin-b"]);
    // No route survived the surface teardown.
    expect(matchSkillRoute("/_plugin/echo", "GET")).toBeNull();
    // And the hook observed an already-clean registry.
    expect(matchAtHookTime).toBeNull();
  });
});
