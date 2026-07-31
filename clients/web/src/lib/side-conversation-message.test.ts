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
    expect(body.sourceChannel).toBe("vellum");
    expect(body.interface).toBe("vellum");
    // `clientOs` is a web-transport concern only.
    expect(body.clientOs).toBeUndefined();
  });

  test("mints a fresh idempotency nonce per send", () => {
    const build = () =>
      buildSideConversationMessageBody({
        conversationId: "conv-1",
        content: "same content",
        transport: "vellum",
      });

    // Guards against hoisting the nonce to module scope, which would make
    // the daemon deduplicate every side-conversation send after the first.
    expect(build().clientMessageId).not.toBe(build().clientMessageId);
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
});
