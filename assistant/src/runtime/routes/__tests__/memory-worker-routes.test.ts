/**
 * Tests for the memory worker status route.
 *
 * The route handler runs inside the daemon and reports the worker process
 * liveness from its PID file plus the resolved embedding-backend status. We mock
 * worker-control and the embedding backend so the test asserts the handler
 * shape.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let workerProbe: { status: "running" | "not_running"; pid?: number } = {
  status: "not_running",
};
let backendStatus: {
  enabled: boolean;
  degraded: boolean;
  provider: string | null;
  model: string | null;
  reason: string | null;
} = {
  enabled: true,
  degraded: false,
  provider: "openai",
  model: "text-embedding-3-small",
  reason: null,
};

mock.module("../../../persistence/worker-control.js", () => ({
  probeMemoryWorker: () => workerProbe,
}));

mock.module("../../../persistence/embeddings/embedding-backend.js", () => ({
  getMemoryBackendStatus: async () => backendStatus,
}));

const { ROUTES, embeddingStatusSchema } =
  await import("../memory-worker-routes.js");

function handler(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`route ${operationId} not registered`);
  return route.handler as () => Promise<Record<string, unknown>>;
}

beforeEach(() => {
  workerProbe = { status: "not_running" };
  backendStatus = {
    enabled: true,
    degraded: false,
    provider: "openai",
    model: "text-embedding-3-small",
    reason: null,
  };
});

describe("memory_worker_status", () => {
  test("reports a running worker with its PID and a resolved embedding backend", async () => {
    workerProbe = { status: "running", pid: 321 };

    const res = await handler("memory_worker_status")();

    expect(res).toEqual({
      status: "running",
      pid: 321,
      embedding: {
        enabled: true,
        degraded: false,
        provider: "openai",
        model: "text-embedding-3-small",
        reason: null,
      },
    });
  });

  test("reports not_running when the worker process is absent", async () => {
    workerProbe = { status: "not_running" };

    const res = await handler("memory_worker_status")();

    expect(res).toMatchObject({ status: "not_running" });
  });

  test("surfaces a resolved gemini embedding backend", async () => {
    backendStatus = {
      enabled: true,
      degraded: false,
      provider: "gemini",
      model: "text-embedding-004",
      reason: null,
    };

    const res = await handler("memory_worker_status")();

    expect(res).toMatchObject({
      embedding: { degraded: false, provider: "gemini" },
    });
  });

  test("surfaces the local embedding backend (the default non-platform provider)", async () => {
    backendStatus = {
      enabled: true,
      degraded: false,
      provider: "local",
      model: "Xenova/all-MiniLM-L6-v2",
      reason: null,
    };

    const res = await handler("memory_worker_status")();

    expect(res).toMatchObject({
      embedding: { degraded: false, provider: "local" },
    });
    // The wire value "local" must satisfy the documented response contract.
    expect(
      embeddingStatusSchema.safeParse((res as { embedding: unknown }).embedding)
        .success,
    ).toBe(true);
  });

  test("surfaces a degraded embedding backend with a reason when none is configured", async () => {
    backendStatus = {
      enabled: true,
      degraded: true,
      provider: null,
      model: null,
      reason: "No embedding backend configured",
    };

    const res = await handler("memory_worker_status")();

    expect(res).toMatchObject({
      embedding: {
        enabled: true,
        degraded: true,
        provider: null,
        model: null,
        reason: "No embedding backend configured",
      },
    });
  });
});
