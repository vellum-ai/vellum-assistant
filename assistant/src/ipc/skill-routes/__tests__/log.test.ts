/**
 * Unit tests for the `host.log` skill IPC route. Mocks the daemon logger
 * factory so we can assert that the route forwards each level, normalizes
 * the `(msg, meta?)` call shape to pino's `(meta, msg)` shape, and handles
 * missing/non-object meta safely.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock the daemon logger
// ---------------------------------------------------------------------------

let calls: Array<{
  name: string;
  level: "debug" | "info" | "warn" | "error";
  meta: Record<string, unknown>;
  msg: string;
}> = [];

function makeMockLogger(name: string) {
  return {
    debug: (meta: Record<string, unknown>, msg: string) =>
      calls.push({ name, level: "debug", meta, msg }),
    info: (meta: Record<string, unknown>, msg: string) =>
      calls.push({ name, level: "info", meta, msg }),
    warn: (meta: Record<string, unknown>, msg: string) =>
      calls.push({ name, level: "warn", meta, msg }),
    error: (meta: Record<string, unknown>, msg: string) =>
      calls.push({ name, level: "error", meta, msg }),
  };
}

mock.module("../../../util/logger.js", () => ({
  getLogger: (name: string) => makeMockLogger(name),
}));

const { hostLogRoute, logRoutes } = await import("../log.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  calls = [];
});

describe("host.log IPC route", () => {
  test("method is host.log", () => {
    expect(hostLogRoute.method).toBe("host.log");
  });

  test("is registered in logRoutes", () => {
    expect(logRoutes).toContain(hostLogRoute);
  });

  test("forwards info-level messages with (meta, msg) shape", async () => {
    const result = await hostLogRoute.handler({
      level: "info",
      msg: "hello world",
      name: "skill:meet-join",
      meta: { conversationId: "conv-1" },
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      name: "skill:meet-join",
      level: "info",
      meta: { conversationId: "conv-1" },
      msg: "hello world",
    });
  });

  test("forwards each level correctly", async () => {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      await hostLogRoute.handler({
        level,
        msg: `msg-${level}`,
        name: "skill:test",
      });
    }
    expect(calls.map((c) => c.level)).toEqual([
      "debug",
      "info",
      "warn",
      "error",
    ]);
  });

  test("defaults to 'skill' logger scope when name is omitted", async () => {
    await hostLogRoute.handler({ level: "info", msg: "no scope" });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("skill");
  });

  test("treats missing meta as an empty object", async () => {
    await hostLogRoute.handler({ level: "warn", msg: "no meta" });

    expect(calls).toHaveLength(1);
    expect(calls[0].meta).toEqual({});
  });

  test("treats non-object meta (e.g. array) as an empty object", async () => {
    await hostLogRoute.handler({
      level: "warn",
      msg: "weird meta",
      meta: ["not", "an", "object"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].meta).toEqual({});
  });

  test("rejects missing level", () => {
    expect(() => hostLogRoute.handler({ msg: "no level" })).toThrow();
  });

  test("rejects unknown level", () => {
    expect(() =>
      hostLogRoute.handler({ level: "fatal", msg: "bad level" }),
    ).toThrow();
  });

  test("rejects missing msg", () => {
    expect(() => hostLogRoute.handler({ level: "info" })).toThrow();
  });
});
