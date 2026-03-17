/**
 * Tests for the callback handoff notification fallback copy template.
 *
 * Verifies that the `ingress.access_request.callback_handoff` template in
 * copy-composer.ts renders caller identity, request code, and trusted-contact
 * member reference correctly — including graceful fallback when fields are missing.
 */
import { describe, expect, test } from "bun:test";

import { composeFallbackCopy } from "../notifications/copy-composer.js";
import type { NotificationSignal } from "../notifications/signal.js";

function buildSignal(
  payloadOverrides: Record<string, unknown> = {},
): NotificationSignal {
  return {
    signalId: "test-signal-1",
    createdAt: Date.now(),
    sourceChannel: "phone",
    sourceContextId: "test-session-1",
    sourceEventName: "ingress.access_request.callback_handoff",
    contextPayload: {
      requestId: "req-123",
      requestCode: null,
      callSessionId: "call-456",
      sourceChannel: "phone",
      reason: "timeout",
      callbackOptIn: true,
      callerPhoneNumber: "+15551234567",
      callerName: null,
      requesterExternalUserId: "+15551234567",
      requesterChatId: "+15551234567",
      requesterMemberId: null,
      requesterMemberSourceChannel: null,
      ...payloadOverrides,
    },
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
  };
}

describe("callback handoff copy template", () => {
  test("renders caller name and phone when both are present", () => {
    const signal = buildSignal({
      callerName: "Alice",
      callerPhoneNumber: "+15551234567",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.title).toBe("Callback Requested");
    expect(copy.body).toContain("Alice (+15551234567)");
    expect(copy.body).toContain("callback");
    expect(copy.body).toContain("unreachable");
  });

  test("renders phone number only when caller name is missing", () => {
    const signal = buildSignal({
      callerName: null,
      callerPhoneNumber: "+15559876543",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).toContain("+15559876543");
    expect(copy.body).not.toContain("null");
  });

  test("renders caller name only when phone is missing", () => {
    const signal = buildSignal({
      callerName: "Bob",
      callerPhoneNumber: null,
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).toContain("Bob");
  });

  test('falls back to "An unknown caller" when both name and phone are missing', () => {
    const signal = buildSignal({
      callerName: null,
      callerPhoneNumber: null,
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).toContain("An unknown caller");
  });

  test("includes request code when present", () => {
    const signal = buildSignal({
      callerName: "Charlie",
      callerPhoneNumber: "+15551111111",
      requestCode: "a1b2c3",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).toContain("A1B2C3");
  });

  test("omits request code line when not present", () => {
    const signal = buildSignal({
      callerName: "Charlie",
      callerPhoneNumber: "+15551111111",
      requestCode: null,
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).not.toContain("Request code");
  });

  test("includes trusted-contact member reference when requesterMemberId is present", () => {
    const signal = buildSignal({
      callerName: "Diana",
      callerPhoneNumber: "+15552222222",
      requesterMemberId: "member-789",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).toContain("trusted contact");
    expect(copy.body).toContain("member-789");
  });

  test("omits member reference line when requesterMemberId is null", () => {
    const signal = buildSignal({
      callerName: "Eve",
      callerPhoneNumber: "+15553333333",
      requesterMemberId: null,
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).not.toContain("trusted contact");
    expect(copy.body).not.toContain("member");
  });

  test("telegram channel gets deliveryText fallback", () => {
    const signal = buildSignal({
      callerName: "Frank",
      callerPhoneNumber: "+15554444444",
    });
    const result = composeFallbackCopy(signal, ["telegram"]);
    const copy = result.telegram!;

    expect(copy.deliveryText).toBeDefined();
    expect(copy.deliveryText!.length).toBeGreaterThan(0);
    expect(copy.deliveryText).toContain("Frank");
  });

  test("telegram channel gets deliveryText fallback", () => {
    const signal = buildSignal({
      callerName: "Grace",
      callerPhoneNumber: "+15555555555",
    });
    const result = composeFallbackCopy(signal, ["telegram"]);
    const copy = result.telegram!;

    expect(copy.deliveryText).toBeDefined();
    expect(copy.deliveryText!.length).toBeGreaterThan(0);
  });

  test("full payload renders all fields correctly", () => {
    const signal = buildSignal({
      callerName: "Hank",
      callerPhoneNumber: "+15556666666",
      requestCode: "ff00aa",
      requesterMemberId: "member-full-test",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.title).toBe("Callback Requested");
    expect(copy.body).toContain("Hank (+15556666666)");
    expect(copy.body).toContain("FF00AA");
    expect(copy.body).toContain("member-full-test");
    expect(copy.body).toContain("callback");
    expect(copy.body).toContain("unreachable");
  });
});
