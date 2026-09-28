import { describe, expect, test } from "bun:test";

import {
  FeatureFlagsIpcResponseSchema,
  VelayStatusIpcResponseSchema,
} from "../gateway-ipc-contracts.js";

describe("gateway status IPC contracts", () => {
  test("filters unsupported feature flag values independently", () => {
    expect(
      FeatureFlagsIpcResponseSchema.parse({
        enabled: true,
        model: "balanced",
        count: 3,
        nested: { enabled: true },
      }),
    ).toEqual({ enabled: true, model: "balanced" });
  });

  test("rejects non-record feature flag responses", () => {
    expect(FeatureFlagsIpcResponseSchema.safeParse([]).success).toBe(false);
    expect(FeatureFlagsIpcResponseSchema.safeParse(null).success).toBe(false);
  });

  test("normalizes a malformed Velay public URL to null", () => {
    expect(
      VelayStatusIpcResponseSchema.parse({
        connected: false,
        publicUrl: 42,
      }),
    ).toEqual({ connected: false, publicUrl: null });
  });

  test("requires a boolean Velay connection state", () => {
    expect(
      VelayStatusIpcResponseSchema.safeParse({ connected: "yes" }).success,
    ).toBe(false);
  });
});
