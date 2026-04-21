import { describe, expect, test } from "bun:test";

import type { ContextOverflowRecoveryConfig } from "../config/schemas/inference.js";
import { ContextOverflowRecoveryConfigSchema } from "../config/schemas/inference.js";
import { resolveOverflowAction } from "../daemon/context-overflow-policy.js";

/** Parse an empty object to get all defaults. */
const DEFAULTS: ContextOverflowRecoveryConfig =
  ContextOverflowRecoveryConfigSchema.parse({});

describe("resolveOverflowAction", () => {
  // ── Disabled recovery ──

  test("returns fail_gracefully when recovery is disabled (interactive)", () => {
    expect(
      resolveOverflowAction({
        overflowRecovery: { ...DEFAULTS, enabled: false },
        isInteractive: true,
      }),
    ).toBe("fail_gracefully");
  });

  test("returns fail_gracefully when recovery is disabled (non-interactive)", () => {
    expect(
      resolveOverflowAction({
        overflowRecovery: { ...DEFAULTS, enabled: false },
        isInteractive: false,
      }),
    ).toBe("fail_gracefully");
  });

  // ── Interactive defaults ──

  test("interactive session with default config auto-compresses", () => {
    expect(
      resolveOverflowAction({
        overflowRecovery: DEFAULTS,
        isInteractive: true,
      }),
    ).toBe("auto_compress_latest_turn");
  });

  // ── Non-interactive defaults ──

  test("non-interactive session with default config auto-compresses", () => {
    expect(
      resolveOverflowAction({
        overflowRecovery: DEFAULTS,
        isInteractive: false,
      }),
    ).toBe("auto_compress_latest_turn");
  });

  // ── Interactive with explicit policies ──

  test("interactive + truncate policy auto-compresses", () => {
    expect(
      resolveOverflowAction({
        overflowRecovery: {
          ...DEFAULTS,
          interactiveLatestTurnCompression: "truncate",
        },
        isInteractive: true,
      }),
    ).toBe("auto_compress_latest_turn");
  });

  test("interactive + summarize policy auto-compresses", () => {
    expect(
      resolveOverflowAction({
        overflowRecovery: {
          ...DEFAULTS,
          interactiveLatestTurnCompression: "summarize",
        },
        isInteractive: true,
      }),
    ).toBe("auto_compress_latest_turn");
  });

  test("interactive + drop policy fails gracefully", () => {
    expect(
      resolveOverflowAction({
        overflowRecovery: {
          ...DEFAULTS,
          interactiveLatestTurnCompression: "drop",
        },
        isInteractive: true,
      }),
    ).toBe("fail_gracefully");
  });

  // ── Non-interactive with explicit policies ──

  test("non-interactive + truncate policy auto-compresses", () => {
    expect(
      resolveOverflowAction({
        overflowRecovery: {
          ...DEFAULTS,
          nonInteractiveLatestTurnCompression: "truncate",
        },
        isInteractive: false,
      }),
    ).toBe("auto_compress_latest_turn");
  });

  test("non-interactive + summarize policy auto-compresses", () => {
    expect(
      resolveOverflowAction({
        overflowRecovery: {
          ...DEFAULTS,
          nonInteractiveLatestTurnCompression: "summarize",
        },
        isInteractive: false,
      }),
    ).toBe("auto_compress_latest_turn");
  });

  test("non-interactive + drop policy fails gracefully", () => {
    expect(
      resolveOverflowAction({
        overflowRecovery: {
          ...DEFAULTS,
          nonInteractiveLatestTurnCompression: "drop",
        },
        isInteractive: false,
      }),
    ).toBe("fail_gracefully");
  });

  // ── Cross-policy independence ──

  test("interactive policy is independent of non-interactive setting", () => {
    expect(
      resolveOverflowAction({
        overflowRecovery: {
          ...DEFAULTS,
          interactiveLatestTurnCompression: "summarize",
          nonInteractiveLatestTurnCompression: "drop",
        },
        isInteractive: true,
      }),
    ).toBe("auto_compress_latest_turn");
  });

  test("non-interactive policy is independent of interactive setting", () => {
    expect(
      resolveOverflowAction({
        overflowRecovery: {
          ...DEFAULTS,
          interactiveLatestTurnCompression: "drop",
          nonInteractiveLatestTurnCompression: "summarize",
        },
        isInteractive: false,
      }),
    ).toBe("auto_compress_latest_turn");
  });

  // ── Default config values match expected behavior ──

  test("default interactiveLatestTurnCompression is summarize", () => {
    expect(DEFAULTS.interactiveLatestTurnCompression).toBe("summarize");
  });

  test("default nonInteractiveLatestTurnCompression is truncate", () => {
    expect(DEFAULTS.nonInteractiveLatestTurnCompression).toBe("truncate");
  });

  test("default enabled is true", () => {
    expect(DEFAULTS.enabled).toBe(true);
  });
});
