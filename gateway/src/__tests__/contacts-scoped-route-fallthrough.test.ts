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

// ---------------------------------------------------------------------------
// Source pinning — no scoped contact registrations in index.ts
// ---------------------------------------------------------------------------

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
 * Router mirroring the contacts control-plane path/method registrations in
 * index.ts plus the runtime-proxy catch-all. Auth is elided: route matching
 * happens before auth, and this harness pins matching only.
 */
function makeContactsRouter() {
  const controlPlane = (route: string) => () =>
    Response.json({ handledBy: "control-plane", route });
  const routes: RouteDefinition[] = [
    {
      path: "/v1/contacts/prompt/submit",
      method: "POST",
      handler: controlPlane("prompt-submit"),
    },
    { path: "/v1/contacts", method: "GET", handler: controlPlane("list") },
    { path: "/v1/contacts", method: "POST", handler: controlPlane("upsert") },
    {
      path: /^\/v1\/contact-channels\/([^/]+)\/verify$/,
      method: "POST",
      handler: controlPlane("verify"),
    },
    {
      path: /^\/v1\/contacts\/(?!invites\/?$)([^/]+)\/?$/,
      method: "DELETE",
      handler: controlPlane("delete"),
    },
    // Runtime proxy catch-all — must be last, matches everything.
    {
      path: /^\//,
      handler: () => Response.json({ handledBy: "runtime-proxy" }),
    },
  ];
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
  return (await res!.json()) as { handledBy: string; route?: string };
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
      expect(body.handledBy).toBe("runtime-proxy");
    },
  );

  test("flat POST /v1/contacts still hits the control-plane handler", async () => {
    const body = await dispatch("POST", "/v1/contacts");
    expect(body).toEqual({ handledBy: "control-plane", route: "upsert" });
  });
});
