/**
 * Tests for `handleCreateToken` (`POST /auth/token`) loopback gating.
 *
 * The endpoint is loopback-only. A same-host reverse proxy / tunnel always
 * connects over 127.0.0.1, so proxied requests must not pass as local. The
 * gate is direct-only: requests carrying forwarding headers are non-local
 * regardless of their raw socket peer.
 *
 * To distinguish "rejected at the loopback gate" (403) from "passed the
 * loopback gate" we give requests that should proceed a valid same-origin
 * `Origin` and no `Authorization`, so they fall through to the 401
 * missing-Authorization check — proving they got past the loopback gate.
 */

import { describe, expect, test } from "bun:test";

import "./test-preload.js";
import { handleCreateToken } from "../http/routes/auth-token.js";

// No module mocks: every case below stops at the loopback gate (403) or the
// missing-Authorization gate (401) before any token verification / guardian
// binding runs, so the real modules are never exercised at runtime. (Avoid
// `mock.module` here — it is process-global in bun and would leak into other
// test files in the same run.)

const LOOPBACK_ORIGIN = "http://localhost:5173";

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request("http://gateway.local/auth/token", {
    method: "POST",
    headers,
  });
}

/** A server whose raw TCP peer is loopback (the same-host proxy case). */
function makeLoopbackServer(address = "127.0.0.1") {
  return {
    requestIP: () => ({ address, port: 12345 }),
  } as never;
}

describe("handleCreateToken — direct loopback gate", () => {
  test("proxied remote caller (XFF non-loopback) is rejected at the loopback gate → 403", async () => {
    const res = await handleCreateToken(
      makeReq({
        "x-forwarded-for": "203.0.113.5",
        origin: LOOPBACK_ORIGIN,
      }),
      makeLoopbackServer(),
    );
    expect(res.status).toBe(403);
  });

  test("direct-local caller (no forwarding headers) passes the loopback gate → reaches 401 missing-Authorization", async () => {
    const res = await handleCreateToken(
      makeReq({ origin: LOOPBACK_ORIGIN }),
      makeLoopbackServer(),
    );
    // Past the loopback gate (would be 403 otherwise) and past the Origin check,
    // it stops at the missing Authorization header.
    expect(res.status).toBe(401);
  });

  test("direct non-loopback peer cannot spoof XFF=127.0.0.1 → 403", async () => {
    // Raw socket peer is NOT loopback (e.g. gateway port exposed directly), so
    // X-Forwarded-For is not trusted and the loopback gate rejects.
    const res = await handleCreateToken(
      makeReq({
        "x-forwarded-for": "127.0.0.1",
        origin: LOOPBACK_ORIGIN,
      }),
      makeLoopbackServer("203.0.113.9"),
    );
    expect(res.status).toBe(403);
  });

  test("X-Forwarded-For makes a loopback socket non-local → 403", async () => {
    const res = await handleCreateToken(
      makeReq({
        "x-forwarded-for": "203.0.113.5",
        origin: LOOPBACK_ORIGIN,
      }),
      makeLoopbackServer(),
    );
    expect(res.status).toBe(403);
  });

  test("Forwarded makes a loopback socket non-local → 403", async () => {
    const res = await handleCreateToken(
      makeReq({
        forwarded: "for=203.0.113.5",
        origin: LOOPBACK_ORIGIN,
      }),
      makeLoopbackServer(),
    );
    expect(res.status).toBe(403);
  });

  test("spoofed XFF=127.0.0.1 over a loopback socket is rejected → 403", async () => {
    const res = await handleCreateToken(
      makeReq({
        "x-forwarded-for": "127.0.0.1",
        origin: LOOPBACK_ORIGIN,
      }),
      makeLoopbackServer(),
    );
    expect(res.status).toBe(403);
  });
});
