/**
 * Tests for the trusted contact lifecycle fallback copy templates.
 *
 * Verifies that `ingress.trusted_contact.guardian_decision` and
 * `ingress.trusted_contact.denied` templates in copy-composer.ts render
 * display names when available and fall back to Slack <@ID> mention format
 * for raw user IDs on the Slack source channel.
 */
import { describe, expect, test } from "bun:test";

import { composeFallbackCopy } from "../notifications/copy-composer.js";
import type { NotificationSignal } from "../notifications/signal.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildGuardianDecisionSignal(
  payloadOverrides: Record<string, unknown> = {},
  sourceChannel: "slack" | "telegram" | "vellum" = "slack",
): NotificationSignal {
  return {
    signalId: "test-signal-gd",
    createdAt: Date.now(),
    sourceChannel,
    sourceContextId: "test-ctx-1",
    sourceEventName: "ingress.trusted_contact.guardian_decision",
    contextPayload: {
      sourceChannel,
      requesterExternalUserId: "U07CLDQ4TB3",
      requesterChatId: "D0AQ9C5PPPF",
      decidedByExternalUserId: "U099H19C0KA",
      requesterDisplayName: null,
      decidedByDisplayName: null,
      decision: "denied",
      ...payloadOverrides,
    },
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
  };
}

function buildDeniedSignal(
  payloadOverrides: Record<string, unknown> = {},
  sourceChannel: "slack" | "telegram" | "vellum" = "slack",
): NotificationSignal {
  return {
    signalId: "test-signal-denied",
    createdAt: Date.now(),
    sourceChannel,
    sourceContextId: "test-ctx-2",
    sourceEventName: "ingress.trusted_contact.denied",
    contextPayload: {
      sourceChannel,
      requesterExternalUserId: "U07CLDQ4TB3",
      requesterChatId: "D0AQ9C5PPPF",
      decidedByExternalUserId: "U099H19C0KA",
      requesterDisplayName: null,
      decidedByDisplayName: null,
      decision: "denied",
      ...payloadOverrides,
    },
    attentionHints: {
      requiresAction: false,
      urgency: "low",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
  };
}

// ── guardian_decision template ────────────────────────────────────────────────

describe("guardian_decision fallback copy", () => {
  test("uses display names when both are present", () => {
    const signal = buildGuardianDecisionSignal({
      requesterDisplayName: "Alice",
      decidedByDisplayName: "Bob",
      decision: "denied",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.title).toBe("Trusted Contact Decision");
    expect(copy.body).toBe("Alice's access request has been denied by Bob.");
  });

  test("falls back to Slack <@ID> mention format when display names are absent on Slack", () => {
    const signal = buildGuardianDecisionSignal({
      requesterDisplayName: null,
      decidedByDisplayName: null,
      requesterExternalUserId: "U07CLDQ4TB3",
      decidedByExternalUserId: "U099H19C0KA",
      sourceChannel: "slack",
      decision: "denied",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).toBe(
      "<@U07CLDQ4TB3>'s access request has been denied by <@U099H19C0KA>.",
    );
  });

  test("uses raw user IDs without Slack formatting on non-Slack channels", () => {
    const signal = buildGuardianDecisionSignal(
      {
        requesterDisplayName: null,
        decidedByDisplayName: null,
        requesterExternalUserId: "U07CLDQ4TB3",
        decidedByExternalUserId: "U099H19C0KA",
        sourceChannel: "telegram",
        decision: "denied",
      },
      "telegram",
    );
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).toBe(
      "U07CLDQ4TB3's access request has been denied by U099H19C0KA.",
    );
    expect(copy.body).not.toContain("<@");
  });

  test("produces distinct copy for approved vs denied decisions", () => {
    const deniedSignal = buildGuardianDecisionSignal({
      requesterDisplayName: "Alice",
      decidedByDisplayName: "Bob",
      decision: "denied",
    });
    const approvedSignal = buildGuardianDecisionSignal({
      requesterDisplayName: "Alice",
      decidedByDisplayName: "Bob",
      decision: "approved",
    });

    const deniedCopy = composeFallbackCopy(deniedSignal, ["vellum"]).vellum!;
    const approvedCopy = composeFallbackCopy(approvedSignal, [
      "vellum",
    ]).vellum!;

    expect(deniedCopy.body).toContain("denied");
    expect(deniedCopy.body).not.toContain("approved");
    expect(approvedCopy.body).toContain("approved");
    expect(approvedCopy.body).not.toContain("denied");
  });

  test("does not expose raw conversation IDs (requesterChatId) in output", () => {
    const signal = buildGuardianDecisionSignal({
      requesterDisplayName: null,
      decidedByDisplayName: null,
      requesterChatId: "D0AQ9C5PPPF",
      requesterExternalUserId: "U07CLDQ4TB3",
      decidedByExternalUserId: "U099H19C0KA",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).not.toContain("D0AQ9C5PPPF");
  });

  test("falls back to 'Someone' when requester identity is entirely absent", () => {
    const signal = buildGuardianDecisionSignal({
      requesterDisplayName: null,
      requesterExternalUserId: null,
      decidedByDisplayName: "Bob",
      decision: "denied",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).toBe("Someone's access request has been denied by Bob.");
  });

  test("falls back to 'a guardian' when decider identity is entirely absent", () => {
    const signal = buildGuardianDecisionSignal({
      requesterDisplayName: "Alice",
      decidedByDisplayName: null,
      decidedByExternalUserId: null,
      decision: "approved",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).toBe(
      "Alice's access request has been approved by a guardian.",
    );
  });

  test("prefers display name over Slack user ID when both are present", () => {
    const signal = buildGuardianDecisionSignal({
      requesterDisplayName: "Alice",
      requesterExternalUserId: "U07CLDQ4TB3",
      decidedByDisplayName: "Bob",
      decidedByExternalUserId: "U099H19C0KA",
      sourceChannel: "slack",
      decision: "denied",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).toBe("Alice's access request has been denied by Bob.");
    expect(copy.body).not.toContain("<@");
  });

  test("sanitizes control characters from display names", () => {
    const signal = buildGuardianDecisionSignal({
      requesterDisplayName: "Alice\x00\x07\nEvil",
      decidedByDisplayName: "Bob\r\nMalicious",
      decision: "approved",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(copy.body).toContain("Alice");
    expect(copy.body).toContain("Bob");
  });

  test("clamps excessively long display names", () => {
    const longName = "A".repeat(200);
    const signal = buildGuardianDecisionSignal({
      requesterDisplayName: longName,
      decidedByDisplayName: "Bob",
      decision: "denied",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    // sanitizeIdentityField clamps to 120 chars + ellipsis
    expect(copy.body.length).toBeLessThan(longName.length);
    expect(copy.body).toContain("…");
  });
});

// ── denied template ──────────────────────────────────────────────────────────

describe("trusted_contact.denied fallback copy", () => {
  test("uses display name when present", () => {
    const signal = buildDeniedSignal({
      requesterDisplayName: "Alice",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.title).toBe("Trusted Contact Denied");
    expect(copy.body).toBe(
      "A trusted contact request from Alice has been denied.",
    );
  });

  test("falls back to Slack <@ID> mention format on Slack when display name absent", () => {
    const signal = buildDeniedSignal({
      requesterDisplayName: null,
      requesterExternalUserId: "U07CLDQ4TB3",
      sourceChannel: "slack",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).toBe(
      "A trusted contact request from <@U07CLDQ4TB3> has been denied.",
    );
  });

  test("uses raw user ID without Slack formatting on non-Slack channels", () => {
    const signal = buildDeniedSignal(
      {
        requesterDisplayName: null,
        requesterExternalUserId: "U07CLDQ4TB3",
        sourceChannel: "telegram",
      },
      "telegram",
    );
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).toBe(
      "A trusted contact request from U07CLDQ4TB3 has been denied.",
    );
    expect(copy.body).not.toContain("<@");
  });

  test("falls back to 'Someone' when requester identity is absent", () => {
    const signal = buildDeniedSignal({
      requesterDisplayName: null,
      requesterExternalUserId: null,
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).toBe(
      "A trusted contact request from Someone has been denied.",
    );
  });

  test("does not expose raw conversation IDs (requesterChatId) in output", () => {
    const signal = buildDeniedSignal({
      requesterDisplayName: null,
      requesterExternalUserId: "U07CLDQ4TB3",
      requesterChatId: "D0AQ9C5PPPF",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).not.toContain("D0AQ9C5PPPF");
  });

  test("sanitizes control characters from display names", () => {
    const signal = buildDeniedSignal({
      requesterDisplayName: "Alice\x00\x07\nEvil",
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    expect(copy.body).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(copy.body).toContain("Alice");
  });

  test("clamps excessively long display names", () => {
    const longName = "A".repeat(200);
    const signal = buildDeniedSignal({
      requesterDisplayName: longName,
    });
    const result = composeFallbackCopy(signal, ["vellum"]);
    const copy = result.vellum!;

    // sanitizeIdentityField clamps to 120 chars + ellipsis
    expect(copy.body.length).toBeLessThan(longName.length);
    expect(copy.body).toContain("…");
  });
});
