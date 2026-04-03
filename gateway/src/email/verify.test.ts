import { describe, it, expect } from "bun:test";
import { verifyEmailWebhookSignature } from "./verify.js";

const SECRET = "my-vellum-email-webhook-secret-abc123";

describe("verifyEmailWebhookSignature", () => {
  const body = '{"from":"sender@example.com","to":"bot@vellum.me"}';

  it("accepts a valid webhook secret header", () => {
    const headers = new Headers({
      "x-vellum-webhook-secret": SECRET,
    });
    expect(verifyEmailWebhookSignature(headers, body, SECRET)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const headers = new Headers({
      "x-vellum-webhook-secret": "wrong-secret",
    });
    expect(verifyEmailWebhookSignature(headers, body, SECRET)).toBe(false);
  });

  it("rejects when header is missing", () => {
    const headers = new Headers();
    expect(verifyEmailWebhookSignature(headers, body, SECRET)).toBe(false);
  });

  it("rejects when secret is empty", () => {
    const headers = new Headers({
      "x-vellum-webhook-secret": SECRET,
    });
    expect(verifyEmailWebhookSignature(headers, body, "")).toBe(false);
  });

  it("rejects when header value is empty", () => {
    const headers = new Headers({
      "x-vellum-webhook-secret": "",
    });
    expect(verifyEmailWebhookSignature(headers, body, SECRET)).toBe(false);
  });

  it("rejects secrets of different lengths", () => {
    const headers = new Headers({
      "x-vellum-webhook-secret": "short",
    });
    expect(verifyEmailWebhookSignature(headers, body, SECRET)).toBe(false);
  });

  it("is not affected by body content (secret-only check)", () => {
    const headers = new Headers({
      "x-vellum-webhook-secret": SECRET,
    });
    // Same secret, different body — should still pass since verification
    // is header-secret comparison only
    expect(verifyEmailWebhookSignature(headers, "different body", SECRET)).toBe(
      true,
    );
  });
});
