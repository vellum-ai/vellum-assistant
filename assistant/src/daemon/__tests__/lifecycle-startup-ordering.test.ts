/**
 * Regression test: daemon startup must populate the analyze-deps singleton
 * BEFORE starting the memory worker.
 *
 * Bug history: the memory worker (`startMemoryJobsWorker`) was kicked off
 * inside the `initializeQdrantAndMemory()` fire-and-forget block, while
 * `setAnalysisDeps()` (the only call site populating the analyze-deps
 * singleton) lived inside `RuntimeHttpServer`'s `buildRouteTable()`. If the
 * worker happened to claim a leftover `conversation_analyze` job before the
 * HTTP server was constructed, the handler would throw "Analysis deps not yet
 * initialized" and the worker would mark the job failed (plain Errors classify
 * as fatal, not retryable), permanently dropping it.
 *
 * Fix: lifecycle.ts constructs `RuntimeHttpServer` (which synchronously calls
 * `setAnalysisDeps()` inside `buildRouteTable()`) BEFORE invoking
 * `void initializeQdrantAndMemory()`. Daemon startup remains non-blocking —
 * the Qdrant init and memory worker startup still run in the background.
 *
 * The two assertions in this file:
 *   1. Source-ordering guard: `lifecycle.ts` must contain the
 *      `new RuntimeHttpServer(` call BEFORE the `void initializeQdrantAndMemory(`
 *      call. This catches future reorderings that would re-introduce the race.
 *   2. Runtime check: constructing `RuntimeHttpServer` with `sendMessageDeps`
 *      provided must populate the analyze-deps singleton synchronously, so the
 *      memory worker (whose first poll happens via a microtask after lifecycle
 *      kicks it off) sees a non-null deps bundle.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
  getGatewayPort: () => 7830,
  getRuntimeHttpPort: () => 7821,
  getRuntimeHttpHost: () => "127.0.0.1",
  getRuntimeGatewayOriginSecret: () => undefined,
  getIngressPublicBaseUrl: () => undefined,
  setIngressPublicBaseUrl: () => {},
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import { initializeDb, resetDb } from "../../memory/db.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import { RuntimeHttpServer } from "../../runtime/http-server.js";
import { getAnalysisDeps } from "../../runtime/services/analyze-deps-singleton.js";

initializeDb();

describe("daemon lifecycle startup ordering", () => {
  let server: RuntimeHttpServer | null = null;

  beforeEach(async () => {
    await server?.stop();
    server = null;
  });

  afterAll(async () => {
    await server?.stop();
    resetDb();
  });

  test("lifecycle.ts constructs RuntimeHttpServer before kicking off initializeQdrantAndMemory", () => {
    // Source-level guard: prevents a future reorder from re-introducing the
    // startup race. We read lifecycle.ts and assert the RuntimeHttpServer
    // constructor call appears before the fire-and-forget memory init.
    const lifecyclePath = join(
      import.meta.dir,
      "..",
      "lifecycle.ts",
    );
    const content = readFileSync(lifecyclePath, "utf-8");

    const httpServerCtorIdx = content.indexOf("new RuntimeHttpServer(");
    const initQdrantIdx = content.indexOf("void initializeQdrantAndMemory(");

    expect(
      httpServerCtorIdx,
      "Expected to find `new RuntimeHttpServer(` in lifecycle.ts",
    ).toBeGreaterThan(-1);
    expect(
      initQdrantIdx,
      "Expected to find `void initializeQdrantAndMemory(` in lifecycle.ts",
    ).toBeGreaterThan(-1);

    expect(
      httpServerCtorIdx,
      "lifecycle.ts must construct RuntimeHttpServer (which synchronously " +
        "populates the analyze-deps singleton via buildRouteTable → " +
        "setAnalysisDeps) BEFORE invoking `void initializeQdrantAndMemory()`. " +
        "Reordering these breaks leftover `conversation_analyze` job " +
        "processing on startup — the memory worker would claim jobs before " +
        "the deps singleton is populated, the handler would throw, and the " +
        "worker would classify the plain Error as fatal and drop the job.",
    ).toBeLessThan(initQdrantIdx);
  });

  test("constructing RuntimeHttpServer with sendMessageDeps populates the analyze-deps singleton synchronously", async () => {
    // Runtime guard: confirms the wiring inside buildRouteTable still calls
    // setAnalysisDeps when sendMessageDeps is provided. If this regression
    // ever moves out of buildRouteTable without an equivalent call site in
    // lifecycle.ts, this assertion fires.
    server = new RuntimeHttpServer({
      port: 0,
      bearerToken: "test-bearer-token",
      sendMessageDeps: {
        getOrCreateConversation: async () => {
          throw new Error("not used in this test");
        },
        assistantEventHub,
        resolveAttachments: () => [],
      },
    });

    // The constructor must have populated the singleton synchronously — no
    // start() call required. The memory worker's first tick runs as a
    // microtask after lifecycle.ts kicks it off, so the singleton must be
    // ready by the time the constructor returns.
    expect(getAnalysisDeps()).not.toBeNull();
  });
});
