import { createHmac } from "node:crypto";
import { describe, it, expect } from "bun:test";
import { verifyEmailWebhookSignature } from "./verify.js";

const SECRET_RAW = Buffer.from("testsecret123456");
const SECRET_BASE64 = SECRET_RAW.toString("base64");
const SECRET_WITH_PREFIX = `whsec_${SECRET_BASE64}`;

function makeSignedHeaders(
  rawBody: string,
  secret = SECRET_WITH_PREFIX,
  overrides?: {
    msgId?: string;
    timestamp?: string;
    tamperSignature?: string;
  },
): Headers {
  const msgId = overrides?.msgId ?? "msg_test123";
  const timestamp =
    overrides?.timestamp ?? String(Math.floor(Date.now() / 1000));

  const secretBytes = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice(6), "base64")
    : Buffer.from(secret, "base64");

  const signedContent = `${msgId}.${timestamp}.${rawBody}`;
  const signature = createHmac("sha256", secretBytes)
    .update(signedContent, "utf8")
    .digest("base64");

  return new Headers({
    "svix-id": msgId,
    "svix-timestamp": timestamp,
    "svix-signature": overrides?.tamperSignature ?? `v1,${signature}`,
  });
}

describe("verifyEmailWebhookSignature", () => {
  const body = '{"eventType":"message.received","eventId":"evt-1"}';

  it("accepts a valid Svix signature", () => {
    const headers = makeSignedHeaders(body);
    expect(verifyEmailWebhookSignature(headers, body, SECRET_WITH_PREFIX)).toBe(
      true,
    );
  });

  it("accepts a secret without the whsec_ prefix", () => {
    const headers = makeSignedHeaders(body, SECRET_BASE64);
    expect(verifyEmailWebhookSignature(headers, body, SECRET_BASE64)).toBe(
      true,
    );
  });

  it("rejects a tampered body", () => {
    const headers = makeSignedHeaders(body);
    expect(
      verifyEmailWebhookSignature(
        headers,
        body + "tampered",
        SECRET_WITH_PREFIX,
      ),
    ).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const headers = makeSignedHeaders(body, SECRET_WITH_PREFIX, {
      tamperSignature: "v1,aW52YWxpZHNpZ25hdHVyZQ==",
    });
    expect(verifyEmailWebhookSignature(headers, body, SECRET_WITH_PREFIX)).toBe(
      false,
    );
  });

  it("rejects an expired timestamp", () => {
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600); // 10 min ago
    const headers = makeSignedHeaders(body, SECRET_WITH_PREFIX, {
      timestamp: oldTimestamp,
    });
    expect(verifyEmailWebhookSignature(headers, body, SECRET_WITH_PREFIX)).toBe(
      false,
    );
  });

  it("rejects when headers are missing", () => {
    const headers = new Headers();
    expect(verifyEmailWebhookSignature(headers, body, SECRET_WITH_PREFIX)).toBe(
      false,
    );
  });

  it("rejects when secret is empty", () => {
    const headers = makeSignedHeaders(body);
    expect(verifyEmailWebhookSignature(headers, body, "")).toBe(false);
  });

  it("accepts multiple signatures when one matches", () => {
    const msgId = "msg_multi";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signedContent = `${msgId}.${timestamp}.${body}`;
    const correctSig = createHmac("sha256", SECRET_RAW)
      .update(signedContent, "utf8")
      .digest("base64");

    const headers = new Headers({
      "svix-id": msgId,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,invalidsig v1,${correctSig}`,
    });
    expect(verifyEmailWebhookSignature(headers, body, SECRET_WITH_PREFIX)).toBe(
      true,
    );
  });
});
