/**
 * Tests for the channel-setup close/hand-off notify helpers.
 *
 * `buildChannelSetupClosedMessage` / `buildChannelSetupHandedOffMessage` are
 * pure and cover the marker shapes the slack-app-setup skill keys off.
 * `notifyChannelSetupClosed` must send a hidden user message to the
 * originating conversation, fail closed when the payload has none, skip
 * daemons that predate end-to-end hidden-send handling, leave the turn store
 * untouched, and swallow every failure — a lost notification only means the
 * user reports back themselves (the skill keeps its manual fallback).
 *
 * NOTE: `bun mock.module` can leak across files — run this file singly:
 *   bun test src/domains/chat/channel-setup-close-notify.test.ts
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import * as sdkGen from "@/generated/daemon/sdk.gen";
import type { MessagesPostData } from "@/generated/daemon/types.gen";

// The generated request type is the source of truth for the wire shape the
// mock receives — no handwritten duplicate to drift.
type MessagesPostCall = Pick<MessagesPostData, "path" | "body"> & {
  throwOnError: false;
};

let postCalls: MessagesPostCall[] = [];
let postShouldThrow = false;
let gateSupportsNotify = true;

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
        // Echo whichever version-gated wire field carried the id, like the
        // daemon does.
        conversationId:
          opts.body.conversationId ?? opts.body.conversationKey ?? "c-minted",
        messageId: "m1",
      },
      error: undefined,
      response: { ok: true, status: 200 },
    });
  },
}));

mock.module("@/lib/backwards-compat/channel-setup-close-notify", () => ({
  MIN_VERSION: "0.10.4",
  resolveSupportsChannelSetupCloseNotify: () =>
    Promise.resolve(gateSupportsNotify),
}));

const {
  buildChannelSetupClosedMessage,
  buildChannelSetupHandedOffMessage,
  notifyChannelSetupClosed,
  notifyChannelSetupHandedOff,
} = await import("./channel-setup-close-notify");
const { useTurnStore } = await import("@/domains/chat/turn-store");

afterEach(() => {
  postCalls = [];
  postShouldThrow = false;
  gateSupportsNotify = true;
  useTurnStore.getState().resetTurn();
});

describe("marker builders", () => {
  test("closed marker follows the daemon's synthetic user-action surface convention", () => {
    expect(buildChannelSetupClosedMessage("slack")).toBe(
      "[User action on channel_setup surface: closed the slack setup wizard]",
    );
  });

  test("hand-off marker shares the same grammar", () => {
    expect(buildChannelSetupHandedOffMessage("slack")).toBe(
      "[User action on channel_setup surface: moved the slack setup to the Contacts page]",
    );
  });

  test("markers are channel-agnostic for future setup wizards", () => {
    expect(buildChannelSetupClosedMessage("telegram")).toContain(
      "closed the telegram setup wizard",
    );
    expect(buildChannelSetupHandedOffMessage("telegram")).toContain(
      "moved the telegram setup to the Contacts page",
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
      "[User action on channel_setup surface: closed the slack setup wizard]",
    );
    // Hidden: persisted and LLM-visible, but suppressed from the transcript.
    expect(postCalls[0]?.body.hidden).toBe(true);
    // The wire field is version-gated (conversationId vs conversationKey);
    // either way it must target the originating conversation.
    expect(
      postCalls[0]?.body.conversationId ?? postCalls[0]?.body.conversationKey,
    ).toBe("c1");
  });

  test("fails closed when the payload has no originating conversation", async () => {
    // Guessing a target (e.g. the close-time active conversation) could wake
    // an unrelated chat or mint a phantom conversation — skip instead.
    await notifyChannelSetupClosed({
      channel: "slack",
      assistantId: "a1",
      assistantName: "Vellum",
    });

    expect(postCalls).toHaveLength(0);
  });

  test("skips daemons that predate end-to-end hidden-send handling", async () => {
    gateSupportsNotify = false;

    await notifyChannelSetupClosed({
      channel: "slack",
      assistantId: "a1",
      assistantName: "Vellum",
      conversationId: "c1",
    });

    expect(postCalls).toHaveLength(0);
  });

  test("never starts a local turn — turn UI for this path is daemon-driven", async () => {
    // No per-send recovery exists here (no poll fallback, no reconciliation
    // kick), so an optimistic "thinking" could strand the UI on an SSE drop.
    // Activity renders via the conversation isProcessing patch and the
    // snapshot reducer instead.
    await notifyChannelSetupClosed({
      channel: "slack",
      assistantId: "a1",
      assistantName: "Vellum",
      conversationId: "c1",
    });

    expect(postCalls).toHaveLength(1);
    expect(useTurnStore.getState().phase).toBe("idle");
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
  });
});

describe("notifyChannelSetupHandedOff", () => {
  test("sends the hidden hand-off marker to the originating conversation", async () => {
    await notifyChannelSetupHandedOff({
      channel: "slack",
      assistantId: "a1",
      assistantName: "Vellum",
      conversationId: "c1",
    });

    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.body.content).toBe(
      "[User action on channel_setup surface: moved the slack setup to the Contacts page]",
    );
    expect(postCalls[0]?.body.hidden).toBe(true);
  });
});
