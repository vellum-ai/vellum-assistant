/**
 * Pins the two markers every throwaway side-conversation send depends on:
 *
 * - `hidden: true` is what the daemon's assistant-reply push producer gates on.
 * - `scripted: true` is what turn telemetry uses to keep these auto-sent turns
 *   out of activation counts (ANT-10).
 *
 * They are asserted separately on purpose. The two are independent markers,
 * not synonyms. A turn can be visible and scripted (the onboarding research
 * prompt), so a future change that derives one from the other would break
 * activation silently while every hidden-marker test stayed green.
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

  test("marks every side-conversation send scripted", () => {
    // Without this, these auto-sent turns are only excluded from activation
    // for owners whose diagnostics consent lets the server-side trace
    // classifier read their message text: the gap ANT-10 was filed for.
    for (const transport of ["vellum", "web"] as const) {
      const body = buildSideConversationMessageBody({
        conversationId: "conv-1",
        content: "auto-sent prompt",
        transport,
      });

      expect(body.scripted).toBe(true);
    }
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
