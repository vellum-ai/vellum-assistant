import { describe, expect, test } from "bun:test";

import {
  channelSupportsGuardianQuestionCards,
  channelSupportsInlineOptions,
  conversationSupportsGuardianQuestionCards,
} from "../channel-ui-capability.js";

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

// Strict subset of the inline-options channels: only channels with a
// notification adapter that renders card actions can receive a parked
// ask_question as a guardian-request card. WhatsApp renders approval buttons
// on direct sends but has no notification adapter, so it must stay false —
// parking a question for it would hang the turn with no card ever delivered.
describe("channelSupportsGuardianQuestionCards", () => {
  test("true only for channels with a card-rendering notification adapter", () => {
    expect(channelSupportsGuardianQuestionCards("telegram")).toBe(true);
    expect(channelSupportsGuardianQuestionCards("slack")).toBe(true);
  });

  test("false for whatsapp (approval buttons but no notification adapter)", () => {
    expect(channelSupportsGuardianQuestionCards("whatsapp")).toBe(false);
  });

  test("false for the app, voice, unknown, and empty ids", () => {
    expect(channelSupportsGuardianQuestionCards("vellum")).toBe(false);
    expect(channelSupportsGuardianQuestionCards("phone")).toBe(false);
    expect(channelSupportsGuardianQuestionCards("")).toBe(false);
    expect(channelSupportsGuardianQuestionCards("mystery")).toBe(false);
  });
});

describe("conversationSupportsGuardianQuestionCards", () => {
  test("reads the channel from per-turn capabilities, then the structural fallback", () => {
    expect(
      conversationSupportsGuardianQuestionCards({
        currentTurnChannelCapabilities: {
          supportsDynamicUi: false,
          channel: "telegram",
        },
      }),
    ).toBe(true);
    expect(
      conversationSupportsGuardianQuestionCards({
        channelCapabilities: { supportsDynamicUi: false, channel: "slack" },
      }),
    ).toBe(true);
  });

  test("false when the channel is card-less or unknown", () => {
    expect(
      conversationSupportsGuardianQuestionCards({
        channelCapabilities: { supportsDynamicUi: false, channel: "whatsapp" },
      }),
    ).toBe(false);
    expect(
      conversationSupportsGuardianQuestionCards({
        channelCapabilities: { supportsDynamicUi: true },
      }),
    ).toBe(false);
    expect(conversationSupportsGuardianQuestionCards({})).toBe(false);
  });
});
