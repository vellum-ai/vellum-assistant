import { describe, it, expect } from "bun:test";
import { normalizeEmailWebhook } from "./normalize.js";

describe("normalizeEmailWebhook", () => {
  function makePayload(overrides?: Record<string, unknown>) {
    return {
      from: "alice@example.com",
      to: "bot@vellum.me",
      messageId: "<msg-1@example.com>",
      conversationId: "conv-1",
      subject: "Test Subject",
      strippedText: "Hello, world!",
      bodyText: "On Mon, someone wrote:\n> old\n\nHello, world!",
      timestamp: "2026-04-03T01:00:00.000Z",
      ...(overrides ?? {}),
    };
  }

  it("normalizes a valid email payload", () => {
    const result = normalizeEmailWebhook(makePayload());
    expect(result).not.toBeNull();
    expect(result!.eventId).toBe("<msg-1@example.com>");
    expect(result!.recipientAddress).toBe("bot@vellum.me");
    expect(result!.event.sourceChannel).toBe("email");
    expect(result!.event.message.content).toBe("Hello, world!");
    expect(result!.event.message.conversationExternalId).toBe("conv-1");
    expect(result!.event.message.externalMessageId).toBe("<msg-1@example.com>");
    expect(result!.event.actor.actorExternalId).toBe("alice@example.com");
    expect(result!.event.actor.displayName).toBe("alice@example.com");
  });

  it("returns null when required fields are missing", () => {
    // Missing 'from'
    expect(
      normalizeEmailWebhook({
        to: "bot@vellum.me",
        messageId: "m",
        conversationId: "c",
      }),
    ).toBeNull();
    // Missing 'to'
    expect(
      normalizeEmailWebhook({
        from: "a@b.com",
        messageId: "m",
        conversationId: "c",
      }),
    ).toBeNull();
    // Missing 'messageId'
    expect(
      normalizeEmailWebhook({
        from: "a@b.com",
        to: "bot@vellum.me",
        conversationId: "c",
      }),
    ).toBeNull();
    // Missing 'conversationId'
    expect(
      normalizeEmailWebhook({
        from: "a@b.com",
        to: "bot@vellum.me",
        messageId: "m",
      }),
    ).toBeNull();
  });

  it("returns null for empty object", () => {
    expect(normalizeEmailWebhook({})).toBeNull();
  });

  it("uses fromName as displayName when provided", () => {
    const result = normalizeEmailWebhook(
      makePayload({ fromName: "Alice Smith" }),
    );
    expect(result).not.toBeNull();
    expect(result!.event.actor.actorExternalId).toBe("alice@example.com");
    expect(result!.event.actor.displayName).toBe("Alice Smith");
  });

  it("falls back to email as displayName when fromName is absent", () => {
    const result = normalizeEmailWebhook(makePayload());
    expect(result!.event.actor.displayName).toBe("alice@example.com");
  });

  it("prefers strippedText over bodyText", () => {
    const result = normalizeEmailWebhook(
      makePayload({
        strippedText: "Just the new reply",
        bodyText: "Full email with quoted content",
      }),
    );
    expect(result!.event.message.content).toBe("Just the new reply");
  });

  it("falls back to bodyText when strippedText is missing", () => {
    const payload = makePayload();
    delete (payload as Record<string, unknown>).strippedText;
    const result = normalizeEmailWebhook(payload);
    expect(result!.event.message.content).toBe(
      "On Mon, someone wrote:\n> old\n\nHello, world!",
    );
  });

  it("uses empty string when both strippedText and bodyText are missing", () => {
    const payload = makePayload();
    delete (payload as Record<string, unknown>).strippedText;
    delete (payload as Record<string, unknown>).bodyText;
    const result = normalizeEmailWebhook(payload);
    expect(result!.event.message.content).toBe("");
  });

  it("uses messageId as eventId", () => {
    const result = normalizeEmailWebhook(
      makePayload({ messageId: "<unique@example.com>" }),
    );
    expect(result!.eventId).toBe("<unique@example.com>");
  });

  it("sets username to sender email", () => {
    const result = normalizeEmailWebhook(makePayload());
    expect(result!.event.actor.username).toBe("alice@example.com");
  });

  it("preserves raw payload in event.raw", () => {
    const payload = makePayload();
    const result = normalizeEmailWebhook(payload);
    expect(result!.event.raw).toEqual(payload);
  });
});
