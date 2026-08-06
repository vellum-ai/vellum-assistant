/**
 * Tests for `withoutTurnScopedTransport`, the guard that keeps per-message view
 * state out of the durable `conversationOptions` map.
 *
 * `getOrCreateConversation` re-applies the stored transport whenever it rebuilds
 * an evicted or stale conversation. Anything describing what the client had on
 * screen for one message must be stripped before it is stored, or a rebuild
 * hours later (a scheduled wake, a background follow-up) would resurrect an app
 * the user has since closed and tell the model it is on screen.
 */

import { describe, expect, test } from "bun:test";

import { withoutTurnScopedTransport } from "../daemon/conversation-store.js";
import type { ConversationCreateOptions } from "../daemon/handlers/shared.js";

describe("withoutTurnScopedTransport", () => {
  test("drops the visible app while keeping durable transport fields", () => {
    const options: ConversationCreateOptions = {
      transport: {
        channelId: "vellum",
        interfaceId: "web",
        clientOs: "macos",
        clientTimezone: "America/Denver",
        visibleAppId: "app-on-screen",
      },
    };

    const stored = withoutTurnScopedTransport(options);

    expect(stored.transport?.visibleAppId).toBeUndefined();
    expect(stored.transport?.clientOs).toBe("macos");
    expect(stored.transport?.clientTimezone).toBe("America/Denver");
    expect(stored.transport?.interfaceId).toBe("web");
  });

  test("does not mutate the caller's options, which still drive this turn", () => {
    const options: ConversationCreateOptions = {
      transport: {
        channelId: "vellum",
        interfaceId: "web",
        visibleAppId: "app-on-screen",
      },
    };

    withoutTurnScopedTransport(options);

    expect(options.transport?.visibleAppId).toBe("app-on-screen");
  });

  test("passes options through untouched when there is no app in view", () => {
    const options: ConversationCreateOptions = {
      transport: { channelId: "vellum", interfaceId: "web", clientOs: "ios" },
    };

    expect(withoutTurnScopedTransport(options)).toBe(options);
  });

  test("passes options through untouched when there is no transport", () => {
    const options: ConversationCreateOptions = {};

    expect(withoutTurnScopedTransport(options)).toBe(options);
  });
});
