import { describe, expect, test } from "bun:test";

import {
  describeSubscriptionModelIncompatibility,
  isConnectionCompatibleWithModel,
} from "../providers/connection-model-compat.js";

describe("isConnectionCompatibleWithModel", () => {
  test("non-oauth_subscription connections are always compatible", () => {
    expect(
      isConnectionCompatibleWithModel(
        { auth: { type: "api_key" } as never },
        "o3",
      ),
    ).toBe(true);
  });

  test("oauth_subscription is compatible with Codex models", () => {
    expect(
      isConnectionCompatibleWithModel(
        { auth: { type: "oauth_subscription" } as never },
        "gpt-5.4",
      ),
    ).toBe(true);
  });

  test("oauth_subscription is incompatible with non-Codex models", () => {
    expect(
      isConnectionCompatibleWithModel(
        { auth: { type: "oauth_subscription" } as never },
        "o3",
      ),
    ).toBe(false);
  });

  test("undefined model is always compatible", () => {
    expect(
      isConnectionCompatibleWithModel(
        { auth: { type: "oauth_subscription" } as never },
        undefined,
      ),
    ).toBe(true);
  });
});

describe("describeSubscriptionModelIncompatibility", () => {
  const subscriptionConn = { auth: { type: "oauth_subscription" as const } as never };
  const apiKeyConn = { auth: { type: "api_key" as const } as never };

  test("returns message when all candidates are oauth_subscription and model is incompatible", () => {
    const msg = describeSubscriptionModelIncompatibility(
      [subscriptionConn],
      "o3",
    );
    expect(msg).toContain("o3");
    expect(msg).toContain("ChatGPT subscription");
  });

  test("returns null when no candidates", () => {
    expect(describeSubscriptionModelIncompatibility([], "o3")).toBeNull();
  });

  test("returns null when model is undefined", () => {
    expect(
      describeSubscriptionModelIncompatibility([subscriptionConn], undefined),
    ).toBeNull();
  });

  test("returns null when some candidates are compatible", () => {
    expect(
      describeSubscriptionModelIncompatibility(
        [subscriptionConn, apiKeyConn],
        "o3",
      ),
    ).toBeNull();
  });

  test("returns null when model is Codex-compatible", () => {
    expect(
      describeSubscriptionModelIncompatibility([subscriptionConn], "gpt-5.4"),
    ).toBeNull();
  });
});
