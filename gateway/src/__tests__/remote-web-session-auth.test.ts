import { describe, expect, test } from "bun:test";

import { AuthRateLimiter } from "../auth-rate-limiter.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { REMOTE_WEB_SESSION_COOKIE } from "../http/remote-web-session-cookie.js";
import { createRouter, type RouteDefinition } from "../http/router.js";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

function mintRemoteWebCookieToken(): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: "actor:self:guardian-001",
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

function makeRouter(routes: RouteDefinition[]) {
  return createRouter(routes, {
    authRateLimiter: new AuthRateLimiter(),
  });
}

describe("remote web session cookie auth", () => {
  test("authenticates edge routes with the remote web session cookie", async () => {
    const router = makeRouter([
      {
        path: "/v1/protected",
        method: "GET",
        auth: "edge",
        handler: () => Response.json({ ok: true }),
      },
    ]);
    const token = mintRemoteWebCookieToken();
    const req = new Request("http://gateway.test/v1/protected", {
      headers: {
        cookie: `${REMOTE_WEB_SESSION_COOKIE}=${encodeURIComponent(token)}`,
      },
    });

    const res = await router(req, new URL(req.url), () => "203.0.113.10");

    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ ok: true });
  });

  test("authenticates scoped routes with the remote web session cookie", async () => {
    const router = makeRouter([
      {
        path: "/v1/settings",
        method: "GET",
        auth: "edge-scoped",
        scope: "settings.read",
        handler: () => Response.json({ ok: true }),
      },
    ]);
    const token = mintRemoteWebCookieToken();
    const req = new Request("http://gateway.test/v1/settings", {
      headers: {
        cookie: `${REMOTE_WEB_SESSION_COOKIE}=${encodeURIComponent(token)}`,
      },
    });

    const res = await router(req, new URL(req.url), () => "203.0.113.10");

    expect(res?.status).toBe(200);
  });

  test("does not let a cookie bypass a malformed Authorization header", async () => {
    const router = makeRouter([
      {
        path: "/v1/protected",
        method: "GET",
        auth: "edge",
        handler: () => Response.json({ ok: true }),
      },
    ]);
    const token = mintRemoteWebCookieToken();
    const req = new Request("http://gateway.test/v1/protected", {
      headers: {
        authorization: "not-a-bearer-token",
        cookie: `${REMOTE_WEB_SESSION_COOKIE}=${encodeURIComponent(token)}`,
      },
    });

    const res = await router(req, new URL(req.url), () => "203.0.113.10");

    expect(res?.status).toBe(401);
  });
});
