/**
 * The dimension probe runs before a read lane's real embed, so a worker that
 * dies during the probe degrades the turn without the lane's own failure
 * classification ever running. The probe therefore carries the same
 * visibility contract itself: a dead worker logs at error with
 * `cause: "embed_worker_died"`, while any other probe failure stays an
 * ordinary degraded-probe warning (JARVIS-1410).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

/** Log calls captured from the module under test, keyed by level. */
const logCalls: { level: string; fields: unknown; message: string }[] = [];

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    error: (fields: unknown, message: string) =>
      logCalls.push({ level: "error", fields, message }),
    warn: (fields: unknown, message: string) =>
      logCalls.push({ level: "warn", fields, message }),
    info: () => {},
    debug: () => {},
  }),
}));

const { resolveBackendDimension } = await import("../embedding-backend.js");
const { EmbeddingWorkerDiedError } = await import("../embedding-types.js");

/** A backend whose probe embed fails the way the caller programs. */
let backendCounter = 0;
function failingBackend(err: unknown) {
  backendCounter += 1;
  return {
    provider: "local" as const,
    // Distinct per test so the per-model dimension cache cannot short-circuit.
    model: `probe-death-${backendCounter}`,
    embed: async () => {
      throw err;
    },
  };
}

describe("dimension probe worker-death visibility", () => {
  beforeEach(() => {
    logCalls.length = 0;
  });

  test("a worker death during the probe logs at error with the cause tag", async () => {
    const dim = await resolveBackendDimension(
      failingBackend(
        new EmbeddingWorkerDiedError(
          "Embedding worker error: Embedding worker process exited unexpectedly",
        ),
      ) as never,
    );

    expect(dim).toBeNull();
    const errors = logCalls.filter((c) => c.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.fields).toMatchObject({ cause: "embed_worker_died" });
    expect(errors[0]!.message).toContain("dense recall degrades");
  });

  test("an untyped worker-death message classifies the same way", async () => {
    const dim = await resolveBackendDimension(
      failingBackend(
        new Error("worker pipe write failed: EPIPE: broken pipe, write"),
      ) as never,
    );

    expect(dim).toBeNull();
    expect(logCalls.filter((c) => c.level === "error")).toHaveLength(1);
  });

  test("any other probe failure stays a warning", async () => {
    const dim = await resolveBackendDimension(
      failingBackend(new Error("connect ECONNREFUSED 127.0.0.1:6333")) as never,
    );

    expect(dim).toBeNull();
    expect(logCalls.filter((c) => c.level === "error")).toHaveLength(0);
    expect(logCalls.filter((c) => c.level === "warn")).toHaveLength(1);
  });
});
