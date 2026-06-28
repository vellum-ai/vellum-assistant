/**
 * Verifies the plugin-namespaced background-job host facet:
 *
 * 1. A plugin enqueues and handles its OWN job via `host.jobs`, and both the
 *    enqueued type and the handler-registered type are `plugin:<id>:`-prefixed
 *    so the queue and the worker registry see a namespaced type the plugin
 *    cannot forge.
 * 2. The worker dispatches a plugin job through the SAME string-keyed registry
 *    the facet wrote into — proving the worker handles plugin jobs without
 *    statically importing plugin code. The handler sees the UNPREFIXED type.
 * 3. A plugin can neither enqueue nor claim a core (non-prefixed) job type
 *    through the facet: a `memory_v2_consolidate` enqueue lands as
 *    `plugin:<id>:memory_v2_consolidate`, and a handler registered for that
 *    name does not intercept a bare core job.
 *
 * The persistence layer is stubbed with `mock.module` so the test exercises
 * the facet wiring (namespacing + registry routing) without a live database —
 * the facet under test imports only the persistence seams, never plugin code.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () => ({
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }),
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({}),
  getNestedValue: () => undefined,
}));

// Capture every enqueue so the test can assert the namespaced type the facet
// wrote to the queue.
const enqueued: Array<{ type: string; payload: Record<string, unknown> }> = [];
const enqueuePluginJobSpy = mock(
  (type: string, payload: Record<string, unknown>) => {
    enqueued.push({ type, payload });
    return `job-${enqueued.length}`;
  },
);
mock.module("../../persistence/jobs-store.js", () => ({
  enqueuePluginJob: enqueuePluginJobSpy,
}));

// Stand in for the worker's string-keyed handler registry. The facet registers
// here; the test dispatches through it exactly as the worker's `processJob`
// does (`jobHandlers.get(type)`), so we confirm dispatch without booting the
// real poll loop.
const registry = new Map<
  string,
  (job: {
    type: string;
    payload: Record<string, unknown>;
    attempts: number;
  }) => unknown
>();
mock.module("../../persistence/jobs-worker.js", () => ({
  registerJobHandler: mock(
    (
      type: string,
      handler: (job: {
        type: string;
        payload: Record<string, unknown>;
        attempts: number;
      }) => unknown,
    ) => {
      registry.set(type, handler);
    },
  ),
}));

import { buildJobsFacet } from "../skill-host-facets.js";

describe("plugin-namespaced background-job host facet", () => {
  test("a plugin enqueues and handles its own namespaced job", async () => {
    enqueued.length = 0;
    registry.clear();

    const jobs = buildJobsFacet("plugin-a");
    const seen: Array<{ type: string; payload: Record<string, unknown> }> = [];
    jobs.registerHandler("consolidate", async (job) => {
      seen.push({ type: job.type, payload: job.payload });
    });

    const id = jobs.enqueue("consolidate", { conversationId: "conv-1" });
    expect(typeof id).toBe("string");

    // Both the enqueued type and the registered handler key are namespaced.
    expect(enqueued).toEqual([
      {
        type: "plugin:plugin-a:consolidate",
        payload: { conversationId: "conv-1" },
      },
    ]);
    expect(registry.has("plugin:plugin-a:consolidate")).toBe(true);

    // The worker dispatches by exact namespaced type. The handler sees the
    // UNPREFIXED type — its own vocabulary.
    const handler = registry.get("plugin:plugin-a:consolidate")!;
    await handler({
      type: "plugin:plugin-a:consolidate",
      payload: { conversationId: "conv-1" },
      attempts: 0,
    });
    expect(seen).toEqual([
      { type: "consolidate", payload: { conversationId: "conv-1" } },
    ]);
  });

  test("two plugins' same logical job type stay isolated", () => {
    enqueued.length = 0;
    registry.clear();

    buildJobsFacet("plugin-a").registerHandler("work", async () => {});
    buildJobsFacet("plugin-b").registerHandler("work", async () => {});

    expect(registry.has("plugin:plugin-a:work")).toBe(true);
    expect(registry.has("plugin:plugin-b:work")).toBe(true);
    // No bare, cross-plugin-claimable key was registered.
    expect(registry.has("work")).toBe(false);

    buildJobsFacet("plugin-a").enqueue("work", {});
    expect(enqueued).toEqual([{ type: "plugin:plugin-a:work", payload: {} }]);
  });

  test("a plugin cannot enqueue or claim a core (non-prefixed) job type", () => {
    enqueued.length = 0;
    registry.clear();

    const jobs = buildJobsFacet("plugin-a");

    // Enqueuing a core type name lands namespaced — it never reaches the core
    // `memory_v2_consolidate` worker handler.
    jobs.enqueue("memory_v2_consolidate", {});
    expect(enqueued).toEqual([
      { type: "plugin:plugin-a:memory_v2_consolidate", payload: {} },
    ]);
    expect(enqueued[0]!.type).not.toBe("memory_v2_consolidate");

    // Registering a handler for a core type name does NOT capture the bare
    // core type the worker dispatches under — it registers under the namespace.
    jobs.registerHandler("memory_v2_consolidate", async () => {});
    expect(registry.has("memory_v2_consolidate")).toBe(false);
    expect(registry.has("plugin:plugin-a:memory_v2_consolidate")).toBe(true);
  });
});
