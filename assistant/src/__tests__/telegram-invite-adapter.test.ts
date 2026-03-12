/**
 * Tests for the Telegram channel invite adapter.
 *
 * Covers `buildShareLink`, `extractInboundToken`, and
 * `resolveChannelHandle` on the real production adapter.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ChannelId } from "../channels/types.js";

// Mock credential metadata so tests don't depend on local persisted state.
mock.module("../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: () => undefined,
}));

// Mock getTelegramBotUsername — the env var fallback was removed so we
// control the return value directly via a mutable variable.
let mockBotUsername: string | undefined;
mock.module("../telegram/bot-username.js", () => ({
  getTelegramBotUsername: () => mockBotUsername,
}));

import { telegramInviteAdapter } from "../runtime/channel-invite-transports/telegram.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHANNEL: ChannelId = "telegram" as ChannelId;

// ---------------------------------------------------------------------------
// buildShareLink
// ---------------------------------------------------------------------------

describe("telegramInviteAdapter.buildShareLink", () => {
  beforeEach(() => {
    mockBotUsername = undefined;
  });

  afterEach(() => {
    mockBotUsername = undefined;
  });

  test("builds a deep link with iv_ prefix", () => {
    mockBotUsername = "TestBot";

    const link = telegramInviteAdapter.buildShareLink!({
      rawToken: "abc123",
      sourceChannel: CHANNEL,
    });

    expect(link.url).toBe("https://t.me/TestBot?start=iv_abc123");
    expect(link.displayText).toContain("https://t.me/TestBot?start=iv_abc123");
  });

  test("throws when bot username is not configured", () => {
    mockBotUsername = undefined;

    expect(() =>
      telegramInviteAdapter.buildShareLink!({
        rawToken: "abc123",
        sourceChannel: CHANNEL,
      }),
    ).toThrow(/bot username/i);
  });
});

// ---------------------------------------------------------------------------
// extractInboundToken
// ---------------------------------------------------------------------------

describe("telegramInviteAdapter.extractInboundToken", () => {
  test("extracts token from structured commandIntent", () => {
    const token = telegramInviteAdapter.extractInboundToken!({
      commandIntent: { type: "start", payload: "iv_tok123" },
      content: "/start iv_tok123",
    });

    expect(token).toBe("tok123");
  });

  test("returns undefined for non-invite commandIntent payload", () => {
    const token = telegramInviteAdapter.extractInboundToken!({
      commandIntent: { type: "start", payload: "gv_guardian_token" },
      content: "/start gv_guardian_token",
    });

    expect(token).toBeUndefined();
  });

  test("returns undefined for commandIntent with empty payload after prefix", () => {
    const token = telegramInviteAdapter.extractInboundToken!({
      commandIntent: { type: "start", payload: "iv_" },
      content: "/start iv_",
    });

    expect(token).toBeUndefined();
  });

  test("falls back to raw content parsing when no commandIntent", () => {
    const token = telegramInviteAdapter.extractInboundToken!({
      content: "/start iv_fallback_token",
    });

    expect(token).toBe("fallback_token");
  });

  test("returns undefined for non-invite raw content", () => {
    const token = telegramInviteAdapter.extractInboundToken!({
      content: "/start gv_something",
    });

    expect(token).toBeUndefined();
  });

  test("returns undefined for plain text content", () => {
    const token = telegramInviteAdapter.extractInboundToken!({
      content: "hello world",
    });

    expect(token).toBeUndefined();
  });

  test("returns undefined for commandIntent with non-start type", () => {
    const token = telegramInviteAdapter.extractInboundToken!({
      commandIntent: { type: "help", payload: "iv_tok" },
      content: "/help iv_tok",
    });

    expect(token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveChannelHandle
// ---------------------------------------------------------------------------

describe("telegramInviteAdapter.resolveChannelHandle", () => {
  beforeEach(() => {
    mockBotUsername = undefined;
  });

  afterEach(() => {
    mockBotUsername = undefined;
  });

  test("returns @-prefixed bot username from config", () => {
    mockBotUsername = "MyBot";

    const handle = telegramInviteAdapter.resolveChannelHandle!();
    expect(handle).toBe("@MyBot");
  });

  test("returns undefined when bot username is not configured", () => {
    mockBotUsername = undefined;

    const handle = telegramInviteAdapter.resolveChannelHandle!();
    expect(handle).toBeUndefined();
  });
});
