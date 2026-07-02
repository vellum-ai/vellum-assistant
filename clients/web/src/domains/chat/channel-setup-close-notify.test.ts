/**
 * Tests for the channel-setup close auto-notify helper.
 *
 * `buildChannelSetupClosedMessage` is pure and covers the marker shape the
 * slack-app-setup skill keys off. `notifyChannelSetupClosed` must send a
 * hidden user message to the originating conversation, fall back to the
 * active conversation, skip when no conversation resolves, and swallow every
 * failure — a lost notification only restores the manual "ask me to check"
 * fallback.
 *
 * NOTE: `bun mock.module` can leak across files — run this file singly:
 *   bun test src/domains/chat/channel-setup-close-notify.test.ts
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import * as sdkGen from "@/generated/daemon/sdk.gen";

interface MessagesPostCall {
  path: { assistant_id: string };
  body: {
    content: string;
    hidden?: boolean;
    conversationId?: string;
    conversationKey?: string | null;
  };
  throwOnError: false;
}

let postCalls: MessagesPostCall[] = [];
let postShouldThrow = false;
let postQueued = false;

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  messagesPost: (opts: MessagesPostCall) => {
    postCalls.push(opts);
    if (postShouldThrow) {
      return Promise.reject(new Error("network blew up"));
    }
    return Promise.resolve({
      data: {
        accepted: true,
        conversationId: opts.body.conversationId ?? "c-minted",
        ...(postQueued ? { queued: true, requestId: "r1" } : { messageId: "m1" }),
      },
      error: undefined,
      response: { ok: true, status: 200 },
    });
  },
}));

const { buildChannelSetupClosedMessage, notifyChannelSetupClosed } =
  await import("./channel-setup-close-notify");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useTurnStore } = await import("@/domains/chat/turn-store");

afterEach(() => {
  postCalls = [];
  postShouldThrow = false;
  postQueued = false;
  useConversationStore.getState().setActiveConversationId(null);
  useTurnStore.getState().resetTurn();
});

describe("buildChannelSetupClosedMessage", () => {
  test("follows the daemon's synthetic user-action marker convention", () => {
    expect(buildChannelSetupClosedMessage("slack")).toBe(
      "[User action on channel_setup panel: closed the slack setup wizard]",
    );
  });

  test("is channel-agnostic for future setup wizards", () => {
    expect(buildChannelSetupClosedMessage("telegram")).toBe(
      "[User action on channel_setup panel: closed the telegram setup wizard]",
    );
  });
});

describe("notifyChannelSetupClosed", () => {
  test("sends a hidden marker message to the originating conversation", async () => {
    await notifyChannelSetupClosed({
      channel: "slack",
      assistantId: "a1",
      assistantName: "Vellum",
      conversationId: "c1",
    });

    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.path).toEqual({ assistant_id: "a1" });
    expect(postCalls[0]?.body.content).toBe(
      "[User action on channel_setup panel: closed the slack setup wizard]",
    );
    // Hidden: persisted and LLM-visible, but suppressed from the transcript.
    expect(postCalls[0]?.body.hidden).toBe(true);
    // The wire field is version-gated (conversationId vs conversationKey);
    // either way it must target the originating conversation.
    expect(
      postCalls[0]?.body.conversationId ?? postCalls[0]?.body.conversationKey,
    ).toBe("c1");
  });

  test("falls back to the active conversation when the payload has none", async () => {
    useConversationStore.getState().setActiveConversationId("c-active");

    await notifyChannelSetupClosed({
      channel: "slack",
      assistantId: "a1",
      assistantName: "Vellum",
    });

    expect(postCalls).toHaveLength(1);
    expect(
      postCalls[0]?.body.conversationId ?? postCalls[0]?.body.conversationKey,
    ).toBe("c-active");
  });

  test("skips silently when no conversation can be resolved", async () => {
    await notifyChannelSetupClosed({
      channel: "slack",
      assistantId: "a1",
      assistantName: "Vellum",
    });

    expect(postCalls).toHaveLength(0);
  });

  test("signals the turn store to expect a reply on an immediate send", async () => {
    await notifyChannelSetupClosed({
      channel: "slack",
      assistantId: "a1",
      assistantName: "Vellum",
      conversationId: "c1",
    });

    expect(useTurnStore.getState().phase).toBe("thinking");
  });

  test("does not start a turn for a queued send (the in-flight turn's SSE drives it)", async () => {
    postQueued = true;

    await notifyChannelSetupClosed({
      channel: "slack",
      assistantId: "a1",
      assistantName: "Vellum",
      conversationId: "c1",
    });

    expect(postCalls).toHaveLength(1);
    expect(useTurnStore.getState().phase).not.toBe("thinking");
  });

  test("swallows a thrown post (best-effort — manual fallback still applies)", async () => {
    postShouldThrow = true;

    await expect(
      notifyChannelSetupClosed({
        channel: "slack",
        assistantId: "a1",
        assistantName: "Vellum",
        conversationId: "c1",
      }),
    ).resolves.toBeUndefined();
    expect(useTurnStore.getState().phase).not.toBe("thinking");
  });
});
