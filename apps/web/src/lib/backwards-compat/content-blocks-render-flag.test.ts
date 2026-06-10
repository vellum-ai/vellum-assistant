/**
 * Tests for the content-blocks render dev flag.
 *
 * Covers:
 *   - localStorage round-trip via get/set
 *   - default is `false` (legacy positional render) when unset
 *   - inspect-only mode (`undefined` arg) is non-destructive and does
 *     not reload
 *   - setting `true`/`false` persists and reloads
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  getRenderFromContentBlocks,
  setRenderFromContentBlocks,
} from "@/lib/backwards-compat/content-blocks-render-flag";

const STORAGE_KEY = "vellum:debug:renderFromContentBlocks";

describe("content-blocks-render-flag", () => {
  let originalReload: typeof window.location.reload;
  let reloadCalls: number;

  beforeEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    reloadCalls = 0;
    // location.reload is non-configurable in jsdom — replace at the
    // descriptor level so we can count calls without actually
    // reloading the test process.
    originalReload = window.location.reload;
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      value: mock(() => {
        reloadCalls += 1;
      }),
    });
  });

  afterEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      value: originalReload,
    });
  });

  test("get returns false when no override is set", () => {
    expect(getRenderFromContentBlocks()).toBe(false);
  });

  test("set true persists and triggers reload", () => {
    const result = setRenderFromContentBlocks(true);
    expect(result).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("true");
    expect(reloadCalls).toBe(1);
    expect(getRenderFromContentBlocks()).toBe(true);
  });

  test("set false persists and triggers reload", () => {
    window.localStorage.setItem(STORAGE_KEY, "true");
    const result = setRenderFromContentBlocks(false);
    expect(result).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("false");
    expect(reloadCalls).toBe(1);
    expect(getRenderFromContentBlocks()).toBe(false);
  });

  test("undefined arg is inspect-only — no reload, no mutation", () => {
    window.localStorage.setItem(STORAGE_KEY, "true");
    const result = setRenderFromContentBlocks();
    expect(result).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("true");
    expect(reloadCalls).toBe(0);
  });

  test("undefined arg returns false when nothing is set", () => {
    const result = setRenderFromContentBlocks();
    expect(result).toBe(false);
    expect(reloadCalls).toBe(0);
  });
});
