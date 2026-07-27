import { describe, expect, test } from "bun:test";

import { channelSupportsInlineOptions } from "../channel-ui-capability.js";

// Single source of truth for which channels' adapters can render inline
// tappable options. `resolveChannelCapabilities` populates
// `ChannelCapabilities.supportsInlineOptions` from this, and the approval
// delivery path reads it directly (retiring the old RICH_APPROVAL_CHANNELS set).
describe("channelSupportsInlineOptions", () => {
  test("true for channels with an inline-button adapter", () => {
    expect(channelSupportsInlineOptions("telegram")).toBe(true);
    expect(channelSupportsInlineOptions("whatsapp")).toBe(true);
    expect(channelSupportsInlineOptions("slack")).toBe(true);
  });

  test("false for the app and text/voice-only channels", () => {
    expect(channelSupportsInlineOptions("vellum")).toBe(false);
    expect(channelSupportsInlineOptions("phone")).toBe(false);
    expect(channelSupportsInlineOptions("email")).toBe(false);
  });

  test("false for unknown and empty channel ids", () => {
    expect(channelSupportsInlineOptions("")).toBe(false);
    expect(channelSupportsInlineOptions("mystery")).toBe(false);
  });
});
