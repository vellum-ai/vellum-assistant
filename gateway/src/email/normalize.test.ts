import { describe, it, expect } from "bun:test";
import {
  evaluateSenderAuthentication,
  normalizeEmailWebhook,
} from "./normalize.js";

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

  it("passes through senderAuthenticated=false so the trust downgrade engages", () => {
    const result = normalizeEmailWebhook(
      makePayload({ senderAuthenticated: false }),
    );
    expect(result!.senderAuthenticated).toBe(false);
  });

  it("passes through senderAuthenticated=true", () => {
    const result = normalizeEmailWebhook(
      makePayload({ senderAuthenticated: true }),
    );
    expect(result!.senderAuthenticated).toBe(true);
  });

  it("omits senderAuthenticated when absent (platform could not evaluate)", () => {
    const result = normalizeEmailWebhook(makePayload());
    expect(result!.senderAuthenticated).toBeUndefined();
  });

  it("ignores a non-boolean senderAuthenticated value", () => {
    const result = normalizeEmailWebhook(
      makePayload({ senderAuthenticated: "pass" }),
    );
    expect(result!.senderAuthenticated).toBeUndefined();
  });

  it("omits attachments when the payload carries none", () => {
    const result = normalizeEmailWebhook(makePayload());
    expect(result!.attachments).toBeUndefined();
  });

  it("parses well-formed attachments", () => {
    const result = normalizeEmailWebhook(
      makePayload({
        attachments: [
          {
            filename: "receipt.pdf",
            contentType: "application/pdf",
            size: 12345,
            content: "YmFzZTY0",
            contentId: "img001@example.com",
          },
        ],
      }),
    );
    expect(result!.attachments).toEqual([
      {
        filename: "receipt.pdf",
        contentType: "application/pdf",
        size: 12345,
        content: "YmFzZTY0",
        contentId: "img001@example.com",
      },
    ]);
  });

  it("drops attachments missing required fields but keeps valid ones", () => {
    const result = normalizeEmailWebhook(
      makePayload({
        attachments: [
          { filename: "no-content.pdf", contentType: "application/pdf" },
          { contentType: "application/pdf", content: "YmFzZTY0" },
          {
            filename: "ok.pdf",
            contentType: "application/pdf",
            content: "YmE=",
          },
          "not-an-object",
        ],
      }),
    );
    expect(result!.attachments).toEqual([
      { filename: "ok.pdf", contentType: "application/pdf", content: "YmE=" },
    ]);
  });

  it("omits attachments when the field is not an array", () => {
    const result = normalizeEmailWebhook(makePayload({ attachments: "nope" }));
    expect(result!.attachments).toBeUndefined();
  });
});

describe("evaluateSenderAuthentication", () => {
  const FROM = "alice@example.com";

  it("treats a DMARC pass as authenticated", () => {
    const authResults =
      "mx.resend.com; spf=pass smtp.mailfrom=example.com; " +
      "dkim=pass header.d=example.com; dmarc=pass header.from=example.com";
    expect(evaluateSenderAuthentication({ authResults, fromEmail: FROM })).toBe(
      true,
    );
  });

  it("treats a DMARC fail as unauthenticated (the spoof case)", () => {
    // From: claims example.com but DMARC failed — a forged sender.
    const authResults =
      "mx.resend.com; spf=fail smtp.mailfrom=attacker.net; " +
      "dkim=none; dmarc=fail header.from=example.com";
    expect(evaluateSenderAuthentication({ authResults, fromEmail: FROM })).toBe(
      false,
    );
  });

  it("treats dmarc=fail as authoritative even when an aligned DKIM passes", () => {
    // The receiver applied the From: domain's own DMARC policy and reported
    // failure, so the aligned `dkim=pass` must not re-authenticate the visible
    // From: — a fail verdict overrides the DKIM-alignment fallback.
    const authResults =
      "mx.resend.com; dkim=pass header.d=example.com; " +
      "dmarc=fail header.from=mail.example.com";
    expect(
      evaluateSenderAuthentication({
        authResults,
        // generic-examples:ignore-next-line — reason: relaxed DMARC alignment needs a subdomain of the reserved example.com
        fromEmail: "alice@mail.example.com",
      }),
    ).toBe(false);
  });

  it("treats a DMARC permerror as unauthenticated despite an aligned DKIM", () => {
    // An evaluation error is not a clean pass: the receiver could not confirm
    // the domain's policy, so we do not substitute our alignment heuristic.
    const authResults =
      "mx.resend.com; dkim=pass header.d=example.com; dmarc=permerror";
    expect(evaluateSenderAuthentication({ authResults, fromEmail: FROM })).toBe(
      false,
    );
  });

  it("treats a DMARC temperror as unauthenticated despite an aligned DKIM", () => {
    const authResults =
      "mx.resend.com; dkim=pass header.d=example.com; dmarc=temperror";
    expect(evaluateSenderAuthentication({ authResults, fromEmail: FROM })).toBe(
      false,
    );
  });

  it("returns undefined when there is no Authentication-Results header", () => {
    // No signal → undefined so the caller omits it and handleInbound preserves
    // existing behavior rather than downgrading every sender on missing data.
    expect(
      evaluateSenderAuthentication({ authResults: undefined, fromEmail: FROM }),
    ).toBeUndefined();
    expect(
      evaluateSenderAuthentication({ authResults: "", fromEmail: FROM }),
    ).toBeUndefined();
  });

  it("treats an aligned DKIM pass without DMARC as authenticated", () => {
    const authResults =
      "mx.resend.com; spf=pass smtp.mailfrom=bounce.example.com; " +
      "dkim=pass header.d=example.com header.s=sel";
    expect(evaluateSenderAuthentication({ authResults, fromEmail: FROM })).toBe(
      true,
    );
  });

  it("falls back to aligned DKIM when DMARC reports no policy (dmarc=none)", () => {
    // `dmarc=none` means the From: domain publishes no DMARC policy — no
    // determination — so an aligned DKIM pass still authenticates, exactly as
    // when the header carries no DMARC verdict at all.
    const authResults =
      "mx.resend.com; dkim=pass header.d=example.com; dmarc=none";
    expect(evaluateSenderAuthentication({ authResults, fromEmail: FROM })).toBe(
      true,
    );
  });

  it("still requires DKIM alignment when DMARC reports no policy (dmarc=none)", () => {
    // `dmarc=none` is not a free pass: without an aligned DKIM the From:
    // remains unauthenticated.
    const authResults =
      "mx.resend.com; dkim=pass header.d=attacker.net; dmarc=none";
    expect(evaluateSenderAuthentication({ authResults, fromEmail: FROM })).toBe(
      false,
    );
  });

  it("treats a DKIM pass for an unaligned domain as unauthenticated", () => {
    // DKIM passed, but for the attacker's own domain — not the From:.
    const authResults =
      "mx.resend.com; spf=pass smtp.mailfrom=attacker.net; " +
      "dkim=pass header.d=attacker.net header.s=sel";
    expect(evaluateSenderAuthentication({ authResults, fromEmail: FROM })).toBe(
      false,
    );
  });

  it("treats an SPF pass alone as unauthenticated", () => {
    // SPF validates the envelope MAIL FROM, not the visible From: header.
    const authResults = "mx.resend.com; spf=pass smtp.mailfrom=attacker.net";
    expect(evaluateSenderAuthentication({ authResults, fromEmail: FROM })).toBe(
      false,
    );
  });

  it("accepts relaxed subdomain alignment", () => {
    const authResults = "mx.resend.com; dkim=pass header.d=example.com";
    expect(
      evaluateSenderAuthentication({
        authResults,
        // generic-examples:ignore-next-line — reason: relaxed DMARC alignment needs a subdomain of the reserved example.com
        fromEmail: "alice@mail.example.com",
      }),
    ).toBe(true);
  });

  it("accepts the DKIM header.i identity domain form", () => {
    const authResults = "mx.resend.com; dkim=pass header.i=@example.com";
    expect(evaluateSenderAuthentication({ authResults, fromEmail: FROM })).toBe(
      true,
    );
  });
});
