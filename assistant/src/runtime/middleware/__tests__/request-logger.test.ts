/**
 * Tests for the per-route success-suppression behavior of `withRequestLogging`.
 *
 * Default behavior (log every request) is exercised end-to-end by the rest
 * of the runtime test suite; the cases here pin down the opt-in
 * `RouteLoggingConfig.silenceSuccessAfter` path.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface CapturedLog {
  level: "info" | "warn" | "error";
  status?: number;
}

const captured: CapturedLog[] = [];

// Replace the module-level logger so the tests see exactly which lines
// would have been emitted, without going through pino at all. The mock
// must be installed BEFORE `request-logger.ts` is loaded — otherwise the
// real `getLogger()` is captured at module init. Dynamic-import the
// module after the mock to enforce that ordering.
mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    info: (data: unknown) =>
      captured.push({ level: "info", status: extractStatus(data) }),
    warn: (data: unknown) =>
      captured.push({ level: "warn", status: extractStatus(data) }),
    error: (data: unknown) =>
      captured.push({ level: "error", status: extractStatus(data) }),
    debug: () => {},
    trace: () => {},
    fatal: () => {},
  }),
}));

const {
  _resetRequestLoggingCountersForTests,
  withRequestLogging,
}: typeof import("../request-logger.js") = await import(
  "../request-logger.js"
);

type RequestLogMetadata = import("../request-logger.js").RequestLogMetadata;

function extractStatus(data: unknown): number | undefined {
  if (data && typeof data === "object" && "status" in data) {
    const s = (data as { status?: unknown }).status;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

function reqAt(path: string): Request {
  return new Request(`http://localhost${path}`);
}

function ok(): Promise<Response> {
  return Promise.resolve(new Response(null, { status: 200 }));
}

function status(code: number): () => Promise<Response> {
  return () => Promise.resolve(new Response(null, { status: code }));
}

describe("withRequestLogging", () => {
  beforeEach(() => {
    captured.length = 0;
    _resetRequestLoggingCountersForTests();
  });

  afterEach(() => {
    _resetRequestLoggingCountersForTests();
  });

  test("logs every successful request when no metadata is supplied", async () => {
    for (let i = 0; i < 10; i++) {
      await withRequestLogging(reqAt("/v1/anything"), ok);
    }
    expect(captured.filter((c) => c.level === "info").length).toBe(10);
    expect(captured.every((c) => c.status === 200)).toBe(true);
  });

  test("silences successes after the configured threshold", async () => {
    const meta: RequestLogMetadata = {
      counterKey: "health",
      config: { silenceSuccessAfter: 3 },
    };
    for (let i = 0; i < 8; i++) {
      await withRequestLogging(reqAt("/v1/health"), ok, meta);
    }
    // First 3 successes log; remaining 5 are suppressed.
    const infos = captured.filter((c) => c.level === "info");
    expect(infos.length).toBe(3);
    expect(infos.every((c) => c.status === 200)).toBe(true);
  });

  test("4xx and 5xx always log, even after success suppression kicks in", async () => {
    const meta: RequestLogMetadata = {
      counterKey: "health",
      config: { silenceSuccessAfter: 2 },
    };
    // Burn through the success budget.
    await withRequestLogging(reqAt("/v1/health"), ok, meta);
    await withRequestLogging(reqAt("/v1/health"), ok, meta);
    // 3rd, 4th, 5th: should be suppressed for 200, but 4xx/5xx must log.
    await withRequestLogging(reqAt("/v1/health"), ok, meta); // suppressed
    await withRequestLogging(reqAt("/v1/health"), status(404), meta); // warn
    await withRequestLogging(reqAt("/v1/health"), status(500), meta); // error
    await withRequestLogging(reqAt("/v1/health"), ok, meta); // suppressed

    expect(captured.filter((c) => c.level === "info").length).toBe(2);
    expect(captured.filter((c) => c.level === "warn").length).toBe(1);
    expect(captured.filter((c) => c.level === "error").length).toBe(1);
  });

  test("counters are isolated per counterKey", async () => {
    const metaA: RequestLogMetadata = {
      counterKey: "route-a",
      config: { silenceSuccessAfter: 2 },
    };
    const metaB: RequestLogMetadata = {
      counterKey: "route-b",
      config: { silenceSuccessAfter: 2 },
    };
    // Exhaust A's budget.
    await withRequestLogging(reqAt("/v1/a"), ok, metaA);
    await withRequestLogging(reqAt("/v1/a"), ok, metaA);
    await withRequestLogging(reqAt("/v1/a"), ok, metaA); // suppressed
    // B still has full budget.
    await withRequestLogging(reqAt("/v1/b"), ok, metaB);
    await withRequestLogging(reqAt("/v1/b"), ok, metaB);

    expect(captured.filter((c) => c.level === "info").length).toBe(4);
  });

  test("a route with `silenceSuccessAfter: 0` is treated as opt-out", async () => {
    // Zero is reserved as "no threshold configured" so config authors can
    // toggle the field without re-deriving the default. The route still
    // logs every request.
    const meta: RequestLogMetadata = {
      counterKey: "zero",
      config: { silenceSuccessAfter: 0 },
    };
    for (let i = 0; i < 4; i++) {
      await withRequestLogging(reqAt("/v1/zero"), ok, meta);
    }
    expect(captured.filter((c) => c.level === "info").length).toBe(4);
  });

  test("errors thrown by the handler propagate and emit an error line", async () => {
    const meta: RequestLogMetadata = {
      counterKey: "boom",
      config: { silenceSuccessAfter: 1 },
    };
    const thrower = () => Promise.reject(new Error("boom"));
    await expect(
      withRequestLogging(reqAt("/v1/boom"), thrower, meta),
    ).rejects.toThrow("boom");
    expect(captured.filter((c) => c.level === "error").length).toBe(1);
  });
});
