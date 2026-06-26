import { describe, expect, test } from "bun:test";

import { channelForCallback } from "../callback-routing.js";

describe("channelForCallback", () => {
  test("resolves each direct-delivery channel from its callback URL", () => {
    expect(channelForCallback("http://gw/deliver/slack?threadTs=1")).toBe(
      "slack",
    );
    expect(channelForCallback("http://gw/deliver/telegram")).toBe("telegram");
    expect(channelForCallback("http://gw/deliver/whatsapp")).toBe("whatsapp");
    expect(channelForCallback("http://gw/deliver/a2a?taskId=t1")).toBe("a2a");
  });

  test("returns undefined for channels not delivered directly", () => {
    expect(channelForCallback("http://gw/deliver/discord")).toBeUndefined();
    expect(channelForCallback("http://gw/deliver/phone")).toBeUndefined();
  });

  test("returns undefined for non-delivery paths", () => {
    expect(channelForCallback("http://gw/v1/messages")).toBeUndefined();
    expect(
      channelForCallback(
        "http://gw/v1/internal/managed-gateway/outbound-send/?route_id=r1",
      ),
    ).toBeUndefined();
  });

  test("returns undefined for unparseable input", () => {
    expect(channelForCallback("not-a-url")).toBeUndefined();
  });

  test("resolves base-less callback paths", () => {
    expect(channelForCallback("/deliver/slack?threadTs=1")).toBe("slack");
  });

  test("resolves relative guardian-style /deliver/<channel> callbacks", () => {
    // resolveDeliverCallbackUrlForChannel() emits these relative URLs for
    // off-channel guardian approvals/denials and timer-driven expiry notices;
    // they must route as direct delivery, not fall through to the HTTP proxy.
    expect(channelForCallback("/deliver/slack")).toBe("slack");
    expect(channelForCallback("/deliver/telegram")).toBe("telegram");
    expect(channelForCallback("/deliver/whatsapp")).toBe("whatsapp");
  });
});
