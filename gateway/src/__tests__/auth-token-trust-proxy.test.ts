/**
 * Tests for `handleCreateToken` (`POST /auth/token`) loopback gating under
 * `trustProxy`.
 *
 * The endpoint is loopback-only. A same-host reverse proxy / tunnel always
 * connects over 127.0.0.1, so without trustProxy a proxied REMOTE caller would
 * pass the loopback gate. With trustProxy the gate judges by the real client IP
 * (first X-Forwarded-For entry). trustProxy defaults false, so direct-loopback
 * callers are unaffected.
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

describe("handleCreateToken — trustProxy loopback gate", () => {
  test("trustProxy=true: proxied remote caller (XFF non-loopback) is rejected at the loopback gate → 403", async () => {
    const res = await handleCreateToken(
      makeReq({
        "x-forwarded-for": "203.0.113.5",
        origin: LOOPBACK_ORIGIN,
      }),
      makeLoopbackServer(),
      true,
    );
    expect(res.status).toBe(403);
  });

  test("trustProxy=true: direct-local caller (no XFF) passes the loopback gate → reaches 401 missing-Authorization", async () => {
    const res = await handleCreateToken(
      makeReq({ origin: LOOPBACK_ORIGIN }),
      makeLoopbackServer(),
      true,
    );
    // Past the loopback gate (would be 403 otherwise) and past the Origin check,
    // it stops at the missing Authorization header.
    expect(res.status).toBe(401);
  });

  test("trustProxy=true: direct non-loopback peer cannot spoof XFF=127.0.0.1 → 403", async () => {
    // Raw socket peer is NOT loopback (e.g. gateway port exposed directly), so
    // X-Forwarded-For is not trusted and the loopback gate rejects.
    const res = await handleCreateToken(
      makeReq({
        "x-forwarded-for": "127.0.0.1",
        origin: LOOPBACK_ORIGIN,
      }),
      makeLoopbackServer("203.0.113.9"),
      true,
    );
    expect(res.status).toBe(403);
  });

  test("trustProxy=false (default): X-Forwarded-For is ignored, loopback socket passes the gate → reaches 401", async () => {
    const res = await handleCreateToken(
      makeReq({
        "x-forwarded-for": "203.0.113.5",
        origin: LOOPBACK_ORIGIN,
      }),
      makeLoopbackServer(),
      false,
    );
    expect(res.status).toBe(401);
  });

  test("trustProxy omitted defaults to false (X-Forwarded-For ignored) → reaches 401", async () => {
    const res = await handleCreateToken(
      makeReq({
        "x-forwarded-for": "203.0.113.5",
        origin: LOOPBACK_ORIGIN,
      }),
      makeLoopbackServer(),
    );
    expect(res.status).toBe(401);
  });
});
