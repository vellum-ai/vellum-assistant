import { describe, expect, test } from "bun:test";

import { deriveIngressIdempotencyKey } from "../process-message.js";

describe("deriveIngressIdempotencyKey", () => {
  test("an explicit clientMessageId wins", () => {
    expect(
      deriveIngressIdempotencyKey({ clientMessageId: "web-nonce-123" }),
    ).toBe("web-nonce-123");
  });

  test("synthesizes a namespaced key from Slack channelId + channelTs", () => {
    expect(
      deriveIngressIdempotencyKey({
        slackInbound: { channelId: "C123", channelTs: "1700000000.000100" },
      }),
    ).toBe("slack:C123:1700000000.000100");
  });

  test("an explicit key takes precedence over the Slack transport id", () => {
    expect(
      deriveIngressIdempotencyKey({
        clientMessageId: "explicit",
        slackInbound: { channelId: "C123", channelTs: "1700000000.000100" },
      }),
    ).toBe("explicit");
  });

  test("returns undefined when no stable id is available (behavior unchanged)", () => {
    expect(deriveIngressIdempotencyKey(undefined)).toBeUndefined();
    expect(deriveIngressIdempotencyKey({})).toBeUndefined();
  });
});
