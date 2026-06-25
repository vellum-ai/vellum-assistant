import { describe, expect, test } from "bun:test";

import { CHANNEL_IDS, isChannelId } from "../channels.js";

describe("isChannelId", () => {
  test("accepts every canonical channel id", () => {
    for (const id of CHANNEL_IDS) {
      expect(isChannelId(id)).toBe(true);
    }
  });

  test("includes the internal channels no external surface ingresses", () => {
    // `platform` (control plane) and `vellum` (native app) are part of the
    // canonical vocabulary even though the gateway never ingresses them. The
    // gateway's narrower list is a compile-time-asserted subset of this set,
    // so these must remain canonical for that assertion to mean anything.
    expect(isChannelId("platform")).toBe(true);
    expect(isChannelId("vellum")).toBe(true);
  });

  test("rejects unknown strings and non-string values", () => {
    expect(isChannelId("discord")).toBe(false);
    expect(isChannelId("")).toBe(false);
    expect(isChannelId(undefined)).toBe(false);
    expect(isChannelId(null)).toBe(false);
    expect(isChannelId(42)).toBe(false);
  });
});
