/**
 * `injectLocalActorHeader` resolves the IPC caller's principal type. Routes
 * that elevate trust gate on `"local"`, so a gateway-proxied remote request
 * must never resolve to `local` — even when it arrives with no verified
 * principal header (e.g. `runtimeProxyRequireAuth` disabled). The
 * `x-vellum-proxy-server: ipc` marker (forwarded by the gateway, never sent by
 * a direct CLI) distinguishes the two.
 */

import { describe, expect, test } from "bun:test";

import { injectLocalActorHeader } from "../assistant-server.js";

describe("injectLocalActorHeader principal resolution", () => {
  test("a forwarded verified principal wins", () => {
    const out = injectLocalActorHeader({
      headers: { "x-vellum-principal-type": "actor" },
    });
    expect(out.headers?.["x-vellum-principal-type"]).toBe("actor");
  });

  test("gateway-proxied IPC with no principal resolves to svc_gateway, not local", () => {
    const out = injectLocalActorHeader({
      headers: { "x-vellum-proxy-server": "ipc" },
    });
    expect(out.headers?.["x-vellum-principal-type"]).toBe("svc_gateway");
  });

  test("a direct IPC caller (no proxy marker, no principal) defaults to local", () => {
    const out = injectLocalActorHeader({ headers: {} });
    expect(out.headers?.["x-vellum-principal-type"]).toBe("local");
  });
});
