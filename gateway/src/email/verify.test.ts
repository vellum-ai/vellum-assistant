import { createHmac } from "node:crypto";
import { describe, it, expect } from "bun:test";
import { verifyEmailWebhookSignature } from "./verify.js";

const SECRET = "test-webhook-secret-1234";

function computeSignature(body: string, secret: string): string {
  return (
    "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex")
  );
}

describe("verifyEmailWebhookSignature", () => {
  const body = '{"from":"sender@example.com","to":"bot@vellum.me"}';

  it("accepts a valid HMAC signature", () => {
    const headers = new Headers({
      "vellum-signature": computeSignature(body, SECRET),
    });
    expect(verifyEmailWebhookSignature(headers, body, SECRET)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const headers = new Headers({
      "vellum-signature": computeSignature(body, "wrong-secret"),
    });
    expect(verifyEmailWebhookSignature(headers, body, SECRET)).toBe(false);
  });

  it("rejects when header is missing", () => {
    const headers = new Headers();
    expect(verifyEmailWebhookSignature(headers, body, SECRET)).toBe(false);
  });

  it("rejects when secret is empty", () => {
    const headers = new Headers({
      "vellum-signature": computeSignature(body, SECRET),
    });
    expect(verifyEmailWebhookSignature(headers, body, "")).toBe(false);
  });

  it("rejects when header value is empty", () => {
    const headers = new Headers({
      "vellum-signature": "",
    });
    expect(verifyEmailWebhookSignature(headers, body, SECRET)).toBe(false);
  });

  it("rejects a signature without sha256= prefix", () => {
    const digest = createHmac("sha256", SECRET)
      .update(body, "utf8")
      .digest("hex");
    const headers = new Headers({
      "vellum-signature": digest,
    });
    expect(verifyEmailWebhookSignature(headers, body, SECRET)).toBe(false);
  });

  it("rejects when body has been tampered with", () => {
    const headers = new Headers({
      "vellum-signature": computeSignature(body, SECRET),
    });
    expect(verifyEmailWebhookSignature(headers, "tampered body", SECRET)).toBe(
      false,
    );
  });

  it("produces different signatures for different bodies", () => {
    const sig1 = computeSignature("body-a", SECRET);
    const sig2 = computeSignature("body-b", SECRET);
    expect(sig1).not.toBe(sig2);

    const headers1 = new Headers({ "vellum-signature": sig1 });
    expect(verifyEmailWebhookSignature(headers1, "body-a", SECRET)).toBe(true);
    expect(verifyEmailWebhookSignature(headers1, "body-b", SECRET)).toBe(false);
  });

  it("rejects a truncated hex digest", () => {
    const headers = new Headers({
      "vellum-signature": "sha256=abcd1234",
    });
    expect(verifyEmailWebhookSignature(headers, body, SECRET)).toBe(false);
  });

  it("rejects non-ASCII hex values without throwing (Buffer byte length divergence)", () => {
    // 64 non-ASCII characters whose UTF-16 .length === 64 (same as a valid
    // hex digest) but whose Buffer byte length > 64, which would cause
    // timingSafeEqual to throw if we only compared string lengths.
    const nonAsciiHex = "\u00e9".repeat(64); // é is 2 bytes in UTF-8
    const headers = new Headers({
      "vellum-signature": `sha256=${nonAsciiHex}`,
    });
    // Must return false cleanly — not throw
    expect(verifyEmailWebhookSignature(headers, body, SECRET)).toBe(false);
  });
});
