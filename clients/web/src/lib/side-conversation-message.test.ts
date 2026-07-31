/**
 * Pins the marker every throwaway side-conversation send depends on: the body
 * always carries `hidden: true`, which is what the daemon's assistant-reply
 * push producer gates on.
 */

import { describe, expect, test } from "bun:test";

import { buildSideConversationMessageBody } from "@/lib/side-conversation-message";

describe("buildSideConversationMessageBody", () => {
  test("marks the send hidden on the vellum transport", () => {
    const body = buildSideConversationMessageBody({
      conversationId: "conv-1",
      content: "<system-message>rewrite</system-message>",
      transport: "vellum",
    });

    expect(body.hidden).toBe(true);
    expect(body.conversationId).toBe("conv-1");
    expect(body.content).toBe("<system-message>rewrite</system-message>");
    expect(body.sourceChannel).toBe("vellum");
    expect(body.interface).toBe("vellum");
    // `clientOs` is a web-transport concern only.
    expect(body.clientOs).toBeUndefined();
  });

  test("marks the send hidden on the web transport and carries the OS", () => {
    const body = buildSideConversationMessageBody({
      conversationId: "conv-2",
      content: "research this",
      transport: "web",
    });

    expect(body.hidden).toBe(true);
    expect(body.interface).toBe("web");
    expect(body.clientOs).toBe("web");
  });

  test("mints a fresh idempotency nonce per send", () => {
    const first = buildSideConversationMessageBody({
      conversationId: "conv-3",
      content: "a",
      transport: "vellum",
    });
    const second = buildSideConversationMessageBody({
      conversationId: "conv-3",
      content: "a",
      transport: "vellum",
    });

    expect(first.clientMessageId).toBeTruthy();
    expect(second.clientMessageId).not.toBe(first.clientMessageId);
  });
});
