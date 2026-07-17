import { describe, it, expect } from "bun:test";
import { normalizeResendToVellumPayload } from "./resend-webhook.js";

/**
 * Resend inbound trust hinges on `senderAuthenticated`, derived from the
 * `Authentication-Results` header returned by the receiving API.
 * `fetchResendEmailContent` lowercases header keys, so the normalizer reads
 * the `authentication-results` key. These tests lock authenticated pass-through
 * vs. forged/unauthenticated downgrade, and the omit-on-missing-data behavior.
 */

const GUARDIAN = "guardian@example.com";

// Structural stand-in for the module-private ResendReceivedEvent shape.
function makeEvent(from: string = GUARDIAN) {
  return {
    type: "email.received" as const,
    created_at: "2026-04-03T01:00:00.000Z",
    data: {
      email_id: "email-1",
      created_at: "2026-04-03T01:00:00.000Z",
      from,
      to: ["bot@example.com"],
      subject: "Test",
      message_id: "<msg-1@example.com>",
    },
  };
}

function makeContent(authResults: string | null): {
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
} {
  return {
    html: null,
    text: "hello",
    headers:
      authResults === null ? {} : { "authentication-results": authResults },
  };
}

describe("normalizeResendToVellumPayload sender authentication", () => {
  it("sets senderAuthenticated=true for a DMARC-authenticated sender", () => {
    const payload = normalizeResendToVellumPayload(
      makeEvent(),
      makeContent("mx.resend.com; dmarc=pass header.from=example.com"),
    );
    expect(payload?.senderAuthenticated).toBe(true);
  });

  it("sets senderAuthenticated=false for a forged (DMARC-failed) sender", () => {
    const payload = normalizeResendToVellumPayload(
      makeEvent(),
      makeContent(
        "mx.resend.com; spf=fail smtp.mailfrom=attacker.net; dmarc=fail header.from=example.com",
      ),
    );
    expect(payload?.senderAuthenticated).toBe(false);
  });

  it("omits senderAuthenticated when the content fetch failed (no content)", () => {
    // No API key / fetch failure → content is null → signal omitted so
    // handleInbound preserves existing behavior on missing data.
    const payload = normalizeResendToVellumPayload(makeEvent(), null);
    expect(payload).not.toBeNull();
    expect(payload?.senderAuthenticated).toBeUndefined();
  });

  it("omits senderAuthenticated when headers carry no Authentication-Results", () => {
    const payload = normalizeResendToVellumPayload(
      makeEvent(),
      makeContent(null),
    );
    expect(payload?.senderAuthenticated).toBeUndefined();
  });
});
