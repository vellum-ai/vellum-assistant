/**
 * Tests for resvg-lazy and the writeTraitsAndRenderAvatar fallback it feeds.
 *
 * Covers the graceful-degradation path when the native @resvg/resvg-js binding
 * is missing (e.g. bun install skipped the platform-specific optional
 * dependency). The lazy loader must warn once and report unavailability, and
 * writeTraitsAndRenderAvatar must return `native_unavailable` so the HTTP
 * layer can respond 503 instead of 500.
 *
 * Bun's `mock.module` evaluates factories eagerly on re-registration, which
 * makes it awkward to flip a module between "throws" and "returns fake
 * export" across tests in the same file. We instead install a single
 * throwing mock at module scope for the require-path test, and use the
 * `__setResvgCacheForTests` / `__resetResvgCacheForTests` hooks to drive the
 * rest of the cases deterministically.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type LogCall = { bindings: unknown; msg: string };
const warnCalls: LogCall[] = [];

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    warn: (bindings: unknown, msg: string) => {
      warnCalls.push({ bindings, msg });
    },
    info: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
  }),
}));

mock.module("../util/platform.js", () => ({
  AVATAR_IMAGE_FILENAME: "avatar-image.png",
  getAvatarDir: () => "/tmp/vellum-test-avatar-never-written",
}));

// Install a throwing @resvg/resvg-js mock at module scope. Bun only calls
// this factory the first time the module is required within the test worker;
// later `require` calls return whatever was produced by that first call (or
// throw, if the factory threw). That's exactly what we want for the
// "require fails" test below.
mock.module("@resvg/resvg-js", () => {
  throw new Error("Cannot require module @resvg/resvg-js-darwin-x64");
});

describe("resvg-lazy — require failure path", () => {
  beforeEach(async () => {
    warnCalls.length = 0;
    const { __resetResvgCacheForTests } = await import("./resvg-lazy.js");
    __resetResvgCacheForTests();
  });

  test("real require failure triggers warn log with platform context", async () => {
    const { isResvgAvailable } = await import("./resvg-lazy.js");

    // Call twice — caching must prevent a duplicate warn.
    expect(isResvgAvailable()).toBe(false);
    expect(isResvgAvailable()).toBe(false);

    expect(warnCalls.length).toBe(1);
    const call = warnCalls[0]!;
    const bindings = call.bindings as Record<string, unknown>;
    expect(bindings.platform).toBe(process.platform);
    expect(bindings.arch).toBe(process.arch);
    expect(String(bindings.module)).toContain("@resvg/resvg-js-");
    expect(bindings.err).toBeInstanceOf(Error);
    expect(call.msg).toContain("@resvg/resvg-js");
  });
});

describe("resvg-lazy — API shape when unavailable", () => {
  beforeEach(async () => {
    warnCalls.length = 0;
    const { __setResvgCacheForTests } = await import("./resvg-lazy.js");
    __setResvgCacheForTests({
      available: false,
      error: new Error("Cannot require module @resvg/resvg-js-darwin-x64"),
    });
  });

  test("isResvgAvailable returns false", async () => {
    const { isResvgAvailable } = await import("./resvg-lazy.js");
    expect(isResvgAvailable()).toBe(false);
  });

  test("getResvg throws the underlying error", async () => {
    const { getResvg } = await import("./resvg-lazy.js");
    expect(() => getResvg()).toThrow(
      /Cannot require module @resvg\/resvg-js-darwin-x64/,
    );
  });
});

describe("writeTraitsAndRenderAvatar — native module missing", () => {
  beforeEach(async () => {
    warnCalls.length = 0;
    const { __setResvgCacheForTests } = await import("./resvg-lazy.js");
    __setResvgCacheForTests({
      available: false,
      error: new Error("Cannot require module @resvg/resvg-js-darwin-x64"),
    });
  });

  test("returns native_unavailable without attempting disk writes", async () => {
    const { writeTraitsAndRenderAvatar } = await import("./traits-png-sync.js");

    const result = writeTraitsAndRenderAvatar({
      bodyShape: "blob",
      eyeStyle: "curious",
      color: "green",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return; // narrow for TypeScript
    expect(result.reason).toBe("native_unavailable");
    expect(result.message).toContain("@resvg/resvg-js");
  });

  test("returns invalid_traits (not native_unavailable) when traits are bad", async () => {
    const { writeTraitsAndRenderAvatar } = await import("./traits-png-sync.js");

    // Empty traits object fails the shape check before we ever consult resvg.
    const result = writeTraitsAndRenderAvatar({
      bodyShape: "",
      eyeStyle: "",
      color: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_traits");
  });
});
