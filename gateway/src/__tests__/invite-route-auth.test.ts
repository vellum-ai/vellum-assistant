/**
 * Auth pinning for the gateway-native invite routes.
 *
 * The invite endpoints were previously proxied to the assistant runtime whose
 * route policies enforced scopes (invites_list → settings.read; create /
 * redeem / revoke / trigger_call → settings.write). The gateway-native
 * rewrite must preserve that contract: registrations use `edge-scoped` with
 * the matching scope, and behaviorally a read-only token (ui_page_v1 —
 * settings.read) must not be able to create/redeem/revoke invites or trigger
 * a real outbound invite call.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import "./test-preload.js";

import type { RouteDefinition } from "../http/router.js";

// --- Mocks (set BEFORE importing the modules under test) ------------------

let mockValidateEdgeToken = mock(
  (
    _token: string,
  ):
    | { ok: true; claims: { sub: string; scope_profile: string } }
    | { ok: false; reason: string } => ({ ok: false, reason: "noop" }),
);
mock.module("../auth/token-exchange.js", () => ({
  validateEdgeToken: (token: string) => mockValidateEdgeToken(token),
}));

const { AuthRateLimiter } = await import("../auth-rate-limiter.js");
const { createRouter } = await import("../http/router.js");

// ---------------------------------------------------------------------------
// Source pinning — registrations in index.ts
// ---------------------------------------------------------------------------

const indexSource = readFileSync(
  join(import.meta.dir, "..", "index.ts"),
  "utf8",
);

/** Route objects in the contacts/invites control-plane section of index.ts. */
function extractInviteRouteObjects(): string[] {
  const start = indexSource.indexOf("// ── Contacts/invites control plane ──");
  const end = indexSource.indexOf("// ── Generic loopback pairing", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  return indexSource
    .slice(start, end)
    .split(/\n    \},\n/)
    .filter((routeObject) => /handle\w*Invite/.test(routeObject));
}

describe("invite route registrations (index.ts)", () => {
  test("all five invite routes use edge-scoped auth with the original runtime scopes", () => {
    const routeObjects = extractInviteRouteObjects();
    expect(routeObjects).toHaveLength(5);

    const expectedScopeByHandler: Record<string, string> = {
      handleListInvites: "settings.read",
      handleCreateInvite: "settings.write",
      handleRedeemInvite: "settings.write",
      handleCallInvite: "settings.write",
      handleRevokeInvite: "settings.write",
    };
    const seen = new Set<string>();

    for (const routeObject of routeObjects) {
      expect(routeObject).toContain('auth: "edge-scoped"');
      expect(routeObject).not.toContain('auth: "edge"');

      const handler = Object.keys(expectedScopeByHandler).find((name) =>
        routeObject.includes(name),
      );
      expect(handler).toBeDefined();
      seen.add(handler!);
      expect(routeObject).toContain(
        `scope: "${expectedScopeByHandler[handler!]}"`,
      );
    }

    expect(seen.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Behavioral — scoped router rejects read-only tokens on write routes
// ---------------------------------------------------------------------------

const UI_PAGE_TOKEN = "tok-ui-page"; // ui_page_v1 → settings.read only
const ACTOR_TOKEN = "tok-actor"; // actor_client_v1 → settings.read + write

/** Router with the invite routes exactly as registered in index.ts. */
function makeInviteRouter() {
  const routes: RouteDefinition[] = [
    {
      path: "/v1/contacts/invites",
      method: "GET",
      auth: "edge-scoped",
      scope: "settings.read",
      handler: () => Response.json({ ok: true, route: "list" }),
    },
    {
      path: "/v1/contacts/invites",
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: () => Response.json({ ok: true, route: "create" }),
    },
    {
      path: "/v1/contacts/invites/redeem",
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: () => Response.json({ ok: true, route: "redeem" }),
    },
    {
      path: /^\/v1\/contacts\/invites\/([^/]+)\/call$/,
      method: "POST",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: () => Response.json({ ok: true, route: "call" }),
    },
    {
      path: /^\/v1\/contacts\/invites\/([^/]+)$/,
      method: "DELETE",
      auth: "edge-scoped",
      scope: "settings.write",
      handler: () => Response.json({ ok: true, route: "revoke" }),
    },
  ];
  return createRouter(routes, { authRateLimiter: new AuthRateLimiter() });
}

async function dispatch(
  method: string,
  path: string,
  token: string,
): Promise<Response | null> {
  const url = new URL(`http://gateway.local${path}`);
  const req = new Request(url, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  // No `server` argument: the loopback fallback requires a server to resolve
  // the peer IP, so auth outcomes here are purely token/scope-driven.
  return makeInviteRouter()(req, url, () => "203.0.113.9");
}

const WRITE_ROUTES: Array<[string, string]> = [
  ["POST", "/v1/contacts/invites"],
  ["POST", "/v1/contacts/invites/redeem"],
  ["POST", "/v1/contacts/invites/inv_1/call"],
  ["DELETE", "/v1/contacts/invites/inv_1"],
];

describe("invite route scope enforcement (behavioral)", () => {
  beforeEach(() => {
    mockValidateEdgeToken = mock((token: string) => {
      if (token === UI_PAGE_TOKEN) {
        return {
          ok: true as const,
          claims: { sub: "svc:ui-page", scope_profile: "ui_page_v1" },
        };
      }
      if (token === ACTOR_TOKEN) {
        return {
          ok: true as const,
          claims: { sub: "svc:client", scope_profile: "actor_client_v1" },
        };
      }
      return { ok: false as const, reason: "unknown token" };
    });
  });

  test.each(WRITE_ROUTES)(
    "%s %s → 403 for a settings.read (ui_page_v1) token",
    async (method, path) => {
      const res = await dispatch(method, path, UI_PAGE_TOKEN);
      expect(res?.status).toBe(403);
    },
  );

  test.each(WRITE_ROUTES)(
    "%s %s → passes for a settings.write (actor_client_v1) token",
    async (method, path) => {
      const res = await dispatch(method, path, ACTOR_TOKEN);
      expect(res?.status).toBe(200);
    },
  );

  test("GET /v1/contacts/invites → passes for a settings.read (ui_page_v1) token", async () => {
    const res = await dispatch("GET", "/v1/contacts/invites", UI_PAGE_TOKEN);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ ok: true, route: "list" });
  });

  test("GET /v1/contacts/invites → passes for an actor_client_v1 token", async () => {
    const res = await dispatch("GET", "/v1/contacts/invites", ACTOR_TOKEN);
    expect(res?.status).toBe(200);
  });

  test("invalid token → 401 on a write route", async () => {
    const res = await dispatch("POST", "/v1/contacts/invites", "tok-bogus");
    expect(res?.status).toBe(401);
  });
});
