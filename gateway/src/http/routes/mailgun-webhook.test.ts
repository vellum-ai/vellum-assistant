import { describe, it, expect } from "bun:test";
import {
  extractMailgunAuthResults,
  normalizeMailgunToVellumPayload,
} from "./mailgun-webhook.js";

/**
 * Mailgun inbound trust hinges on `senderAuthenticated`, derived from the
 * `Authentication-Results` header the receiving MTA stamps. These tests lock
 * the extraction (first, receiver-stamped verdict wins) and the normalizer
 * wiring (authenticated pass-through vs. forged/unauthenticated downgrade).
 */

const GUARDIAN = "guardian@example.com";

function messageHeaders(pairs: Array<[string, string]>): string {
  return JSON.stringify(pairs);
}

function fields(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    from: GUARDIAN,
    recipient: "bot@example.com",
    "Message-Id": "<msg-1@example.com>",
    subject: "Test",
    "body-plain": "hello",
    ...overrides,
  };
}

describe("extractMailgunAuthResults", () => {
  it("returns the Authentication-Results value from message-headers", () => {
    const headers = messageHeaders([
      ["Received", "from mx by mailgun"],
      [
        "Authentication-Results",
        "mx.mailgun.org; dmarc=pass header.from=example.com",
      ],
      ["From", GUARDIAN],
    ]);
    expect(
      extractMailgunAuthResults(fields({ "message-headers": headers })),
    ).toBe("mx.mailgun.org; dmarc=pass header.from=example.com");
  });

  it("returns the FIRST Authentication-Results (the receiver-prepended one)", () => {
    // A spoofer can inject their own Authentication-Results in the message body;
    // it sits BELOW the receiver's prepended verdict, so the first wins.
    const headers = messageHeaders([
      [
        "Authentication-Results",
        "mx.mailgun.org; dmarc=fail header.from=example.com",
      ],
      ["Authentication-Results", "spoofed; dmarc=pass header.from=example.com"],
    ]);
    expect(
      extractMailgunAuthResults(fields({ "message-headers": headers })),
    ).toBe("mx.mailgun.org; dmarc=fail header.from=example.com");
  });

  it("returns undefined when message-headers is absent", () => {
    expect(extractMailgunAuthResults(fields())).toBeUndefined();
  });

  it("returns undefined when message-headers is not valid JSON", () => {
    expect(
      extractMailgunAuthResults(fields({ "message-headers": "not-json" })),
    ).toBeUndefined();
  });

  it("returns undefined when no Authentication-Results header is present", () => {
    const headers = messageHeaders([
      ["Received", "x"],
      ["From", GUARDIAN],
    ]);
    expect(
      extractMailgunAuthResults(fields({ "message-headers": headers })),
    ).toBeUndefined();
  });
});

describe("normalizeMailgunToVellumPayload sender authentication", () => {
  it("sets senderAuthenticated=true for a DMARC-authenticated sender", () => {
    const headers = messageHeaders([
      [
        "Authentication-Results",
        "mx.mailgun.org; dmarc=pass header.from=example.com",
      ],
    ]);
    const payload = normalizeMailgunToVellumPayload(
      fields({ "message-headers": headers }),
    );
    expect(payload?.senderAuthenticated).toBe(true);
  });

  it("sets senderAuthenticated=false for a forged (DMARC-failed) sender", () => {
    // The spoof case: From: claims the guardian but DMARC failed. handleInbound
    // collapses this out of the guardian/trusted_contact tiers.
    const headers = messageHeaders([
      [
        "Authentication-Results",
        "mx.mailgun.org; spf=fail smtp.mailfrom=attacker.net; dmarc=fail header.from=example.com",
      ],
    ]);
    const payload = normalizeMailgunToVellumPayload(
      fields({ "message-headers": headers }),
    );
    expect(payload?.senderAuthenticated).toBe(false);
  });

  it("omits senderAuthenticated when Mailgun sent no auth header", () => {
    const payload = normalizeMailgunToVellumPayload(fields());
    expect(payload).not.toBeNull();
    expect(payload?.senderAuthenticated).toBeUndefined();
  });
});
