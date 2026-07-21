/**
 * Tests for `POST /v1/pair/qr-code`: loopback-only mint of single-use QR pairing
 * codes. The mint route touches no DB or signing key — it only writes to the
 * in-memory code store — so the setup is limited to resetting that store.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { handleMintQrPairingCode } from "../http/routes/pair-qr-code.js";
import {
  getQrPairingCodeCountForTests,
  resetQrPairingCodesForTests,
} from "../remote-web/qr-pairing-code-store.js";

const LOOPBACK_IP = "127.0.0.1";

function makeMintRequest(
  opts: { headers?: Record<string, string>; method?: string } = {},
): Request {
  return new Request("http://localhost:7830/v1/pair/qr-code", {
    method: opts.method ?? "POST",
    headers: { host: "localhost:7830", ...opts.headers },
  });
}

beforeEach(() => {
  resetQrPairingCodesForTests();
});

afterEach(() => {
  resetQrPairingCodesForTests();
});

describe("POST /v1/pair/qr-code mint", () => {
  test("mints a code for a loopback caller", async () => {
    const res = await handleMintQrPairingCode(makeMintRequest(), LOOPBACK_IP);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.code).toBe("string");
    // 32 random bytes as base64url ⇒ 43 chars, well over 128 bits of entropy.
    expect((body.code as string).length).toBeGreaterThanOrEqual(43);
    expect(typeof body.expiresAt).toBe("string");
    expect(body.expiresInSeconds).toBe(300);
    expect(getQrPairingCodeCountForTests()).toBe(1);
  });

  test("mints a distinct code on each call", async () => {
    const first = (await (
      await handleMintQrPairingCode(makeMintRequest(), LOOPBACK_IP)
    ).json()) as { code: string };
    const second = (await (
      await handleMintQrPairingCode(makeMintRequest(), LOOPBACK_IP)
    ).json()) as { code: string };

    expect(first.code).not.toBe(second.code);
    expect(getQrPairingCodeCountForTests()).toBe(2);
  });

  test("rejects a non-loopback peer and mints nothing", async () => {
    const res = await handleMintQrPairingCode(makeMintRequest(), "8.8.8.8");

    expect(res.status).toBe(403);
    expect(getQrPairingCodeCountForTests()).toBe(0);
  });

  test("rejects an edge-forwarded request from a loopback peer", async () => {
    // The nginx edge sets the unspoofable marker; a loopback peer IP alone must
    // not be treated as local when the request came over the tunnel.
    const res = await handleMintQrPairingCode(
      makeMintRequest({ headers: { "x-vellum-edge-forwarded": "1" } }),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(403);
    expect(getQrPairingCodeCountForTests()).toBe(0);
  });

  test("rejects an X-Forwarded-For request", async () => {
    const res = await handleMintQrPairingCode(
      makeMintRequest({ headers: { "x-forwarded-for": "8.8.8.8" } }),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(403);
    expect(getQrPairingCodeCountForTests()).toBe(0);
  });

  test("rejects a request carrying a browser Origin (WebView mint-and-readback)", async () => {
    const res = await handleMintQrPairingCode(
      makeMintRequest({ headers: { origin: "https://app.vellum.local" } }),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(403);
    expect(getQrPairingCodeCountForTests()).toBe(0);
  });

  test("rejects a non-POST method with 405", async () => {
    const res = await handleMintQrPairingCode(
      makeMintRequest({ method: "GET" }),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(405);
    expect(getQrPairingCodeCountForTests()).toBe(0);
  });
});
