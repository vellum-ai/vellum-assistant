import { describe, expect, test } from "bun:test";

import {
  channelSupportsInlineOptions,
  channelSupportsInlineQuestions,
  conversationSupportsInlineQuestions,
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

// Strict subset of channelSupportsInlineOptions: only channels whose adapter
// renders the ask_question wizard. Gates ask_question parking, so Slack/WhatsApp
// (approval buttons but no wizard yet) must be false to avoid hanging the turn.
describe("channelSupportsInlineQuestions", () => {
  test("true only for channels with a question wizard (Telegram today)", () => {
    expect(channelSupportsInlineQuestions("telegram")).toBe(true);
  });

  test("false for approval-button channels without a question wizard", () => {
    expect(channelSupportsInlineQuestions("whatsapp")).toBe(false);
    expect(channelSupportsInlineQuestions("slack")).toBe(false);
  });

  test("false for the app, text/voice-only, unknown, and empty ids", () => {
    expect(channelSupportsInlineQuestions("vellum")).toBe(false);
    expect(channelSupportsInlineQuestions("phone")).toBe(false);
    expect(channelSupportsInlineQuestions("email")).toBe(false);
    expect(channelSupportsInlineQuestions("")).toBe(false);
    expect(channelSupportsInlineQuestions("mystery")).toBe(false);
  });
});

describe("conversationSupportsInlineQuestions", () => {
  test("reads the per-turn capability, then the structural fallback", () => {
    expect(
      conversationSupportsInlineQuestions({
        currentTurnChannelCapabilities: {
          supportsDynamicUi: false,
          supportsInlineQuestions: true,
        },
      }),
    ).toBe(true);
    expect(
      conversationSupportsInlineQuestions({
        channelCapabilities: {
          supportsDynamicUi: false,
          supportsInlineQuestions: true,
        },
      }),
    ).toBe(true);
  });

  test("defaults to false when unset (opt-in per channel)", () => {
    expect(
      conversationSupportsInlineQuestions({
        channelCapabilities: { supportsDynamicUi: false },
      }),
    ).toBe(false);
    expect(conversationSupportsInlineQuestions({})).toBe(false);
  });
});
