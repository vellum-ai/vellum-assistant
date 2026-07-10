/**
 * Pins that the gateway registers NO assistant-scoped contact routes.
 *
 * The generated gateway SDK emits assistant-scoped URLs, but both deployment
 * boundaries flatten contact-family paths before the gateway routes them
 * (Django's RuntimeProxyView in cloud; `rewriteForSelfHostedIngress` in
 * self-hosted), so the gateway serves only the flat contact routes and a
 * scoped contact request falls through to the runtime-proxy catch-all.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import "./test-preload.js";

import { AuthRateLimiter } from "../auth-rate-limiter.js";
import type { RouteDefinition } from "../http/router.js";
import { createRouter } from "../http/router.js";
import { buildMarkedContactRoutes } from "./helpers/contact-route-table.js";

// ---------------------------------------------------------------------------
// Source pinning — no scoped contact registrations in index.ts
// ---------------------------------------------------------------------------

// Belt-and-suspenders grep over index.ts; the route-table tests below pin the
// real registrations.
describe("contact route registrations (index.ts)", () => {
  test("no route path scopes a contact-family path under /v1/assistants", () => {
    const indexSource = readFileSync(
      join(import.meta.dir, "..", "index.ts"),
      "utf8",
    );
    const pathLines = indexSource
      .split("\n")
      .filter((line) => /^\s*path:/.test(line));

    expect(pathLines.length).toBeGreaterThan(0);
    const scopedContactPaths = pathLines.filter(
      (line) => line.includes("assistants") && line.includes("contact"),
    );
    expect(scopedContactPaths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Behavioral — scoped contact writes fall through to the catch-all
// ---------------------------------------------------------------------------

/**
 * Router built from the SAME route table index.ts registers
 * (`buildContactsControlPlaneRoutes`), plus the runtime-proxy catch-all.
 * Auth is mapped to "none": route matching happens before auth, and this
 * harness pins matching only.
 */
function makeContactsRouter() {
  const routes: RouteDefinition[] = buildMarkedContactRoutes().map((route) => ({
    ...route,
    auth: "none" as const,
    scope: undefined,
  }));
  // Runtime proxy catch-all — must be last, matches everything.
  routes.push({
    path: /^\//,
    handler: () => Response.json({ marker: "runtime-proxy" }),
  });
  return createRouter(routes, { authRateLimiter: new AuthRateLimiter() });
}

const contactsRouter = makeContactsRouter();

async function dispatch(method: string, path: string) {
  const url = new URL(`http://gateway.local${path}`);
  const res = await contactsRouter(
    new Request(url, { method }),
    url,
    () => "203.0.113.9",
  );
  expect(res).not.toBeNull();
  return (await res!.json()) as { marker: string };
}

const SCOPED_CONTACT_WRITES: Array<[string, string]> = [
  ["POST", "/v1/assistants/x/contacts"],
  ["POST", "/v1/assistants/x/contacts/prompt/submit"],
  ["POST", "/v1/assistants/x/contact-channels/ch-1/verify"],
  ["DELETE", "/v1/assistants/x/contacts/contact-1"],
];

describe("scoped contact writes fall through to the runtime proxy", () => {
  test.each(SCOPED_CONTACT_WRITES)(
    "%s %s → runtime-proxy catch-all, not the control plane",
    async (method, path) => {
      const body = await dispatch(method, path);
      expect(body.marker).toBe("runtime-proxy");
    },
  );

  test("flat POST /v1/contacts still hits the control-plane handler", async () => {
    const body = await dispatch("POST", "/v1/contacts");
    expect(body).toEqual({ marker: "handleUpsertContact" });
  });
});

describe("registration-order invariants within the flat table", () => {
  test("DELETE /v1/contacts/invites/:id revokes the invite, not a contact", async () => {
    const body = await dispatch("DELETE", "/v1/contacts/invites/inv-1");
    expect(body).toEqual({ marker: "handleRevokeInvite" });
  });

  test("DELETE /v1/contacts/:id still deletes the contact", async () => {
    const body = await dispatch("DELETE", "/v1/contacts/contact-1");
    expect(body).toEqual({ marker: "handleDeleteContact" });
  });

  test("daemon-only subpaths fall through to the runtime proxy", async () => {
    for (const path of ["/v1/contacts/search", "/v1/contacts/prompt"]) {
      const body = await dispatch("POST", path);
      expect(body).toEqual({ marker: "runtime-proxy" });
    }
  });
});
