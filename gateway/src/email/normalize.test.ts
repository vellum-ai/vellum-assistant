import { describe, it, expect } from "bun:test";
import { normalizeEmailWebhook } from "./normalize.js";

describe("normalizeEmailWebhook", () => {
  function makePayload(overrides?: Record<string, unknown>) {
    return {
      type: "event",
      eventType: "message.received",
      eventId: "evt-abc",
      message: {
        inboxId: "inbox-1",
        threadId: "thread-1",
        messageId: "msg-1",
        from: "alice@example.com",
        to: ["bot@mail.vellum.ai"],
        subject: "Test Subject",
        text: "Hello, world!",
        timestamp: "2026-04-03T01:00:00.000Z",
        createdAt: "2026-04-03T01:00:00.000Z",
      },
      ...(overrides ?? {}),
    };
  }

  it("normalizes a message.received event", () => {
    const result = normalizeEmailWebhook(makePayload());
    expect(result).not.toBeNull();
    expect(result!.eventId).toBe("evt-abc");
    expect(result!.recipientAddress).toBe("bot@mail.vellum.ai");
    expect(result!.event.sourceChannel).toBe("email");
    expect(result!.event.message.content).toBe("Hello, world!");
    expect(result!.event.message.conversationExternalId).toBe("thread-1");
    expect(result!.event.message.externalMessageId).toBe("msg-1");
    expect(result!.event.actor.actorExternalId).toBe("alice@example.com");
    expect(result!.event.actor.displayName).toBe("alice@example.com");
  });

  it("returns null for non-message.received events", () => {
    expect(
      normalizeEmailWebhook({
        eventType: "message.delivered",
        eventId: "evt-del",
      }),
    ).toBeNull();
    expect(
      normalizeEmailWebhook({
        eventType: "message.bounced",
        eventId: "evt-bounce",
      }),
    ).toBeNull();
  });

  it("returns null when message is missing", () => {
    expect(
      normalizeEmailWebhook({
        eventType: "message.received",
        eventId: "evt-no-msg",
      }),
    ).toBeNull();
  });

  it("parses display name from angle bracket format", () => {
    const payload = makePayload();
    (payload.message as Record<string, unknown>).from =
      "Alice Smith <alice@example.com>";
    const result = normalizeEmailWebhook(payload);
    expect(result).not.toBeNull();
    expect(result!.event.actor.actorExternalId).toBe("alice@example.com");
    expect(result!.event.actor.displayName).toBe("Alice Smith");
  });

  it("strips quotes from display name", () => {
    const payload = makePayload();
    (payload.message as Record<string, unknown>).from =
      '"Bob Jones" <bob@example.com>';
    const result = normalizeEmailWebhook(payload);
    expect(result!.event.actor.displayName).toBe("Bob Jones");
    expect(result!.event.actor.actorExternalId).toBe("bob@example.com");
  });

  it("prefers extractedText over text", () => {
    const payload = makePayload();
    (payload.message as Record<string, unknown>).text =
      "Full email with quoted content";
    (payload.message as Record<string, unknown>).extractedText =
      "Just the new reply";
    const result = normalizeEmailWebhook(payload);
    expect(result!.event.message.content).toBe("Just the new reply");
  });

  it("falls back to text when extractedText is missing", () => {
    const payload = makePayload();
    (payload.message as Record<string, unknown>).text = "Full text only";
    delete (payload.message as Record<string, unknown>).extractedText;
    const result = normalizeEmailWebhook(payload);
    expect(result!.event.message.content).toBe("Full text only");
  });

  it("uses empty string when both text and extractedText are missing", () => {
    const payload = makePayload();
    delete (payload.message as Record<string, unknown>).text;
    delete (payload.message as Record<string, unknown>).extractedText;
    const result = normalizeEmailWebhook(payload);
    expect(result!.event.message.content).toBe("");
  });

  it("uses first recipient in to array as recipientAddress", () => {
    const payload = makePayload();
    (payload.message as Record<string, unknown>).to = [
      "first@example.com",
      "second@example.com",
    ];
    const result = normalizeEmailWebhook(payload);
    expect(result!.recipientAddress).toBe("first@example.com");
  });

  it("returns null when from is missing", () => {
    const payload = makePayload();
    delete (payload.message as Record<string, unknown>).from;
    expect(normalizeEmailWebhook(payload)).toBeNull();
  });

  it("falls back to messageId for eventId when eventId is missing", () => {
    const payload = makePayload();
    delete (payload as Record<string, unknown>).eventId;
    const result = normalizeEmailWebhook(payload);
    expect(result!.eventId).toBe("msg-1");
  });
});
