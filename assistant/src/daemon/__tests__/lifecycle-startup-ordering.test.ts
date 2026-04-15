/**
 * Invariant: the analyze-deps singleton must be populated before the memory
 * worker starts, so any `conversation_analyze` job the worker claims on its
 * first poll sees a non-null deps bundle.
 *
 * Assertions:
 *   1. Source-ordering guard: `lifecycle.ts` constructs `RuntimeHttpServer`
 *      (which synchronously calls `setAnalysisDeps()` inside
 *      `buildRouteTable()`) before invoking `void initializeQdrantAndMemory()`
 *      (which kicks off the memory worker).
 *   2. Runtime check: constructing `RuntimeHttpServer` with `sendMessageDeps`
 *      populates the analyze-deps singleton synchronously by the time the
 *      constructor returns.
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
    // Source-level guard: read lifecycle.ts and assert the RuntimeHttpServer
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
        "Otherwise the memory worker can claim a leftover " +
        "`conversation_analyze` job before the deps singleton is populated, " +
        "the handler throws, and the worker classifies the plain Error as " +
        "fatal and drops the job.",
    ).toBeLessThan(initQdrantIdx);
  });

  test("constructing RuntimeHttpServer with sendMessageDeps populates the analyze-deps singleton synchronously", async () => {
    // Runtime guard: confirms the wiring inside buildRouteTable calls
    // setAnalysisDeps when sendMessageDeps is provided. If that call ever
    // moves out of buildRouteTable without an equivalent call site in
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

    // The constructor populates the singleton synchronously — no start()
    // call required. The memory worker's first tick runs as a microtask
    // after lifecycle.ts kicks it off, so the singleton must be ready by
    // the time the constructor returns.
    expect(getAnalysisDeps()).not.toBeNull();
  });
});
