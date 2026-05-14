import { createHmac } from "node:crypto";
import { describe, it, expect } from "bun:test";
import { verifySvixSignature } from "./verify.js";

// `whsec_` + base64("test-signing-key-1234567890")
const SECRET = "whsec_dGVzdC1zaWduaW5nLWtleS0xMjM0NTY3ODkw";
const BARE_SECRET = "dGVzdC1zaWduaW5nLWtleS0xMjM0NTY3ODkw";

function computeSig(
  msgId: string,
  timestamp: number,
  body: string,
  secret: string,
): string {
  const secretPart = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const secretBytes = Buffer.from(secretPart, "base64");
  const signedContent = `${msgId}.${timestamp}.${body}`;
  const sig = createHmac("sha256", secretBytes)
    .update(signedContent, "utf8")
    .digest("base64");
  return `v1,${sig}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function makeHeaders(
  msgId: string,
  timestamp: number | string,
  signature: string,
): Headers {
  return new Headers({
    "svix-id": msgId,
    "svix-timestamp": String(timestamp),
    "svix-signature": signature,
  });
}

describe("verifySvixSignature", () => {
  const body = '{"from":"sender@example.com","to":"bot@vellum.me"}';

  it("accepts a valid v1 signature", () => {
    const msgId = "msg_valid";
    const ts = nowSec();
    const headers = makeHeaders(msgId, ts, computeSig(msgId, ts, body, SECRET));
    expect(verifySvixSignature(headers, body, SECRET)).toBe(true);
  });

  it("accepts a secret without the `whsec_` prefix", () => {
    const msgId = "msg_bare";
    const ts = nowSec();
    const headers = makeHeaders(
      msgId,
      ts,
      computeSig(msgId, ts, body, BARE_SECRET),
    );
    expect(verifySvixSignature(headers, body, BARE_SECRET)).toBe(true);
  });

  it("rejects a signature for a different body (tampered)", () => {
    const msgId = "msg_tampered";
    const ts = nowSec();
    const headers = makeHeaders(msgId, ts, computeSig(msgId, ts, body, SECRET));
    expect(verifySvixSignature(headers, "tampered body", SECRET)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const msgId = "msg_wrong_secret";
    const ts = nowSec();
    const wrongSecret = "whsec_d3Jvbmcta2V5LWZvci10ZXN0aW5n";
    const headers = makeHeaders(
      msgId,
      ts,
      computeSig(msgId, ts, body, wrongSecret),
    );
    expect(verifySvixSignature(headers, body, SECRET)).toBe(false);
  });

  it("rejects when svix-id header is missing", () => {
    const ts = nowSec();
    const headers = new Headers({
      "svix-timestamp": String(ts),
      "svix-signature": computeSig("msg_x", ts, body, SECRET),
    });
    expect(verifySvixSignature(headers, body, SECRET)).toBe(false);
  });

  it("rejects when svix-timestamp header is missing", () => {
    const headers = new Headers({
      "svix-id": "msg_x",
      "svix-signature": computeSig("msg_x", nowSec(), body, SECRET),
    });
    expect(verifySvixSignature(headers, body, SECRET)).toBe(false);
  });

  it("rejects when svix-signature header is missing", () => {
    const headers = new Headers({
      "svix-id": "msg_x",
      "svix-timestamp": String(nowSec()),
    });
    expect(verifySvixSignature(headers, body, SECRET)).toBe(false);
  });

  it("rejects when secret is empty", () => {
    const msgId = "msg_x";
    const ts = nowSec();
    const headers = makeHeaders(msgId, ts, computeSig(msgId, ts, body, SECRET));
    expect(verifySvixSignature(headers, body, "")).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    const msgId = "msg_x";
    const ts = nowSec();
    const headers = makeHeaders(
      msgId,
      "not-a-number",
      computeSig(msgId, ts, body, SECRET),
    );
    expect(verifySvixSignature(headers, body, SECRET)).toBe(false);
  });

  it("rejects timestamps older than 5 minutes (replay protection)", () => {
    const stale = nowSec() - 6 * 60;
    const msgId = "msg_stale";
    const headers = makeHeaders(
      msgId,
      stale,
      computeSig(msgId, stale, body, SECRET),
    );
    expect(verifySvixSignature(headers, body, SECRET)).toBe(false);
  });

  it("rejects timestamps further than 5 minutes in the future", () => {
    const future = nowSec() + 6 * 60;
    const msgId = "msg_future";
    const headers = makeHeaders(
      msgId,
      future,
      computeSig(msgId, future, body, SECRET),
    );
    expect(verifySvixSignature(headers, body, SECRET)).toBe(false);
  });

  it("accepts timestamps within the 5-minute tolerance window", () => {
    const recent = nowSec() - 4 * 60;
    const msgId = "msg_recent";
    const headers = makeHeaders(
      msgId,
      recent,
      computeSig(msgId, recent, body, SECRET),
    );
    expect(verifySvixSignature(headers, body, SECRET)).toBe(true);
  });

  it("accepts when one of multiple v1 entries matches", () => {
    const msgId = "msg_multi";
    const ts = nowSec();
    const validSig = computeSig(msgId, ts, body, SECRET);
    const compositeHeader = `v2,unrelatedB64== ${validSig} v1,bogus==`;
    const headers = new Headers({
      "svix-id": msgId,
      "svix-timestamp": String(ts),
      "svix-signature": compositeHeader,
    });
    expect(verifySvixSignature(headers, body, SECRET)).toBe(true);
  });

  it("rejects when only v2 entries are present", () => {
    const msgId = "msg_only_v2";
    const ts = nowSec();
    const headers = new Headers({
      "svix-id": msgId,
      "svix-timestamp": String(ts),
      "svix-signature": "v2,someB64== v2,otherB64==",
    });
    expect(verifySvixSignature(headers, body, SECRET)).toBe(false);
  });

  it("rejects entries without a comma separator", () => {
    const msgId = "msg_malformed";
    const ts = nowSec();
    const headers = new Headers({
      "svix-id": msgId,
      "svix-timestamp": String(ts),
      "svix-signature": "malformedNoComma",
    });
    expect(verifySvixSignature(headers, body, SECRET)).toBe(false);
  });

  it("produces different signatures for different bodies", () => {
    const msgId = "msg_diff";
    const ts = nowSec();
    const sigA = computeSig(msgId, ts, "body-a", SECRET);
    const sigB = computeSig(msgId, ts, "body-b", SECRET);
    expect(sigA).not.toBe(sigB);

    const headersA = makeHeaders(msgId, ts, sigA);
    expect(verifySvixSignature(headersA, "body-a", SECRET)).toBe(true);
    expect(verifySvixSignature(headersA, "body-b", SECRET)).toBe(false);
  });
});
