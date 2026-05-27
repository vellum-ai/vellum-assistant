/**
 * Unit tests for the HeyAPI client request interceptor.
 *
 * Pins the ATL-703 header contract: every outbound request — regardless of
 * method — must carry `X-Vellum-Client-Id` + `X-Vellum-Interface-Id` so the
 * daemon can echo the originator id back on `sync_changed` and the hub can
 * suppress the SSE echo to that subscriber.
 *
 * The test calls `requestInterceptor` directly instead of round-tripping
 * through the HeyAPI client. That way we don't depend on any private
 * interceptor-list internals; if the interceptor function gets the inputs
 * right, the registrations at the bottom of the module do the rest.
 *
 * @jest-environment happy-dom
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { requestInterceptor } from "@/lib/api-interceptors";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import { getClientId } from "@/lib/telemetry/client-identity";
import { useOrganizationStore } from "@/stores/organization-store";

const TEST_ORG_ID = "org-test-1234";

function setCsrfCookie(token: string): void {
  document.cookie = `csrftoken=${token}; path=/`;
}

function clearCsrfCookie(): void {
  document.cookie = "csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
}

async function intercept(method: string, url = "https://example.test/v1/probe") {
  const request = new Request(url, { method });
  const result = await requestInterceptor(request);
  return result.headers;
}

describe("api-interceptors / requestInterceptor", () => {
  beforeAll(() => {
    useOrganizationStore.setState({ currentOrganizationId: TEST_ORG_ID });
    setCsrfCookie("test-csrf-token");
  });

  afterAll(() => {
    clearCsrfCookie();
  });

  test("attaches X-Vellum-Client-Id and X-Vellum-Interface-Id on GET", async () => {
    const headers = await intercept("GET");
    expect(headers.get("X-Vellum-Client-Id")).toBe(getClientId());
    expect(headers.get("X-Vellum-Interface-Id")).toBe("vellum");
  });

  test("attaches X-Vellum-Client-Id and X-Vellum-Interface-Id on POST", async () => {
    const headers = await intercept("POST");
    expect(headers.get("X-Vellum-Client-Id")).toBe(getClientId());
    expect(headers.get("X-Vellum-Interface-Id")).toBe("vellum");
  });

  test("attaches client + interface headers on PUT, PATCH, DELETE", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const headers = await intercept(method);
      expect(headers.get("X-Vellum-Client-Id")).toBe(getClientId());
      expect(headers.get("X-Vellum-Interface-Id")).toBe("vellum");
    }
  });

  test("attaches Vellum-Organization-Id when an active org is set", async () => {
    const headers = await intercept("GET");
    expect(headers.get("Vellum-Organization-Id")).toBe(TEST_ORG_ID);
  });

  test("attaches X-CSRFToken on mutating requests", async () => {
    const headers = await intercept("POST");
    expect(headers.get("X-CSRFToken")).toBe("test-csrf-token");
  });

  test("does not attach X-CSRFToken on safe requests", async () => {
    const headers = await intercept("GET");
    expect(headers.get("X-CSRFToken")).toBeNull();
  });

  test("returns a new Request, leaving the input headers untouched", async () => {
    const input = new Request("https://example.test/v1/probe", { method: "POST" });
    expect(input.headers.get("X-Vellum-Client-Id")).toBeNull();

    const output = await requestInterceptor(input);
    expect(output).not.toBe(input);
    expect(input.headers.get("X-Vellum-Client-Id")).toBeNull();
    expect(output.headers.get("X-Vellum-Client-Id")).toBe(getClientId());
  });
});

// ---------------------------------------------------------------------------
// Self-hosted rewriting
// ---------------------------------------------------------------------------
//
// When the assistant resolves to `{ kind: "self_hosted" }`, the lifecycle
// hook calls `setSelfHostedConnection({ url, token })`. From that point
// on, allowlisted runtime-proxied `/v1/assistants/{id}/<segment>/...`
// calls leave the platform's base URL behind and go directly to the
// user's gateway. The allowlist is intentionally narrow — see
// `RUNTIME_PROXIED_FIRST_SEGMENTS` in `api-interceptors.ts` for why we
// don't mirror Django's full proxy routing table.
//
// These tests pin the invariants that make that handoff safe:
//   - URL origin gets swapped to the registered ingress.
//   - Platform-only headers (Vellum-Organization-Id, X-CSRFToken) are
//     stripped so the user's gateway never sees our session/CSRF state.
//   - `Authorization: Bearer <token>` is attached when the connection
//     has a token, and omitted when the token slot is `null` (the
//     gateway then 401s, and the chat surface lands on its error UI —
//     this is the deliberate behaviour during the brief post-hatch
//     window where `bootstrap_platform_actor_token` hasn't landed yet).
//   - Client/interface identity headers ride along so the gateway can
//     still echo them back for self-echo suppression once SSE lands.
//
// Negative tests confirm we don't route to the gateway when (a) no
// connection is set, (b) the path's first segment isn't on the allowlist
// (`activate`, `maintenance-mode`, `system-events`, `terminal`, …), or
// (c) the path is the bare retrieve route `/v1/assistants/{id}/`.

const SELF_HOSTED_ID = "01h1234567890abcdefg";
const INGRESS = "https://my-gateway.example";
const ACTOR_TOKEN = "test-actor-token-abc123";
const RUNTIME_PROXIED_PATH = `/v1/assistants/${SELF_HOSTED_ID}/conversations/`;

describe("api-interceptors / self-hosted rewriting", () => {
  beforeAll(() => {
    useOrganizationStore.setState({ currentOrganizationId: TEST_ORG_ID });
    setCsrfCookie("test-csrf-token");
  });

  afterAll(() => {
    clearCsrfCookie();
  });

  afterEach(() => {
    setSelfHostedConnection(null);
  });

  test("rewrites the URL origin to the configured ingress", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}?limit=50`);
    const output = await requestInterceptor(input);
    const outUrl = new URL(output.url);
    expect(outUrl.origin).toBe(INGRESS);
    expect(outUrl.pathname).toBe(RUNTIME_PROXIED_PATH);
    expect(outUrl.search).toBe("?limit=50");
  });

  test("strips platform-only headers from the rewritten request", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`, {
      method: "POST",
    });
    const output = await requestInterceptor(input);
    expect(output.headers.get("Vellum-Organization-Id")).toBeNull();
    expect(output.headers.get("X-CSRFToken")).toBeNull();
  });

  test("attaches Authorization: Bearer <token> when the actor token is set", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`);
    const output = await requestInterceptor(input);
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
  });

  test("omits the Authorization header when the actor token slot is null", async () => {
    // Brief post-hatch window: `is_local=true` and `ingress_url` is
    // known but `bootstrap_platform_actor_token` hasn't landed yet.
    // The interceptor leaves Authorization off; the gateway 401s; the
    // chat surface lands on its error state. Don't fall back to
    // platform session credentials here — that would silently route
    // a self-hosted request through the wrong trust boundary.
    setSelfHostedConnection({ url: INGRESS, token: null });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`);
    const output = await requestInterceptor(input);
    expect(output.headers.get("Authorization")).toBeNull();
  });

  test("preserves client + interface identity headers across the rewrite", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`);
    const output = await requestInterceptor(input);
    expect(output.headers.get("X-Vellum-Client-Id")).toBe(getClientId());
    expect(output.headers.get("X-Vellum-Interface-Id")).toBe("vellum");
  });

  test("omits cookie credentials on the rewritten request", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`);
    const output = await requestInterceptor(input);
    expect(output.credentials).toBe("omit");
  });

  test("does NOT rewrite when no connection is set", async () => {
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`);
    const output = await requestInterceptor(input);
    expect(new URL(output.url).origin).toBe("https://platform.test");
    expect(output.headers.get("Vellum-Organization-Id")).toBe(TEST_ORG_ID);
    expect(output.headers.get("Authorization")).toBeNull();
  });

  test("does NOT rewrite when ingress url is null even if token is set", async () => {
    // Symmetric to the "token-null" window: an assistant can be
    // `is_local=true` with a token already bootstrapped but no public
    // gateway hostname yet. Without an ingress to rewrite to, the
    // request falls through to the platform proxy view — which 404s,
    // surfacing as the chat error state one HTTP hop sooner.
    setSelfHostedConnection({ url: null, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`);
    const output = await requestInterceptor(input);
    expect(new URL(output.url).origin).toBe("https://platform.test");
    expect(output.headers.get("Authorization")).toBeNull();
  });

  test("does NOT rewrite first segments outside the allowlist", async () => {
    // Codex flagged that a deny-list approach was structurally fragile
    // (missed `maintenance-mode`, `system-events`, etc.). The narrow
    // allowlist makes the failure mode the opposite: anything not
    // explicitly enumerated falls through to the platform. Pin the
    // non-rewriting contract for the routes that are most likely to
    // get mistakenly captured.
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    for (const segment of [
      "activate",
      "resize",
      "restart",
      "retire",
      "backups",
      "maintenance-mode",
      "system-events",
      "terminal",
      "doctor",
      "release-channel",
      "domains",
      "email-addresses",
    ]) {
      const input = new Request(
        `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/${segment}/`,
        { method: "POST" },
      );
      const output = await requestInterceptor(input);
      expect(new URL(output.url).origin).toBe("https://platform.test");
      // Platform path keeps stamping org + CSRF as before.
      expect(output.headers.get("Vellum-Organization-Id")).toBe(TEST_ORG_ID);
      expect(output.headers.get("X-CSRFToken")).toBe("test-csrf-token");
      // And never leaks the gateway token onto a platform-bound
      // request, even when the connection slot is populated.
      expect(output.headers.get("Authorization")).toBeNull();
    }
  });

  test("does NOT rewrite the bare retrieve route", async () => {
    // `/v1/assistants/{id}/` is the canonical retrieve — the assistant
    // record lives on the platform regardless of where the runtime
    // runs. Routing it to ingress would 404.
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(
      `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/`,
    );
    const output = await requestInterceptor(input);
    expect(new URL(output.url).origin).toBe("https://platform.test");
    expect(output.headers.get("Authorization")).toBeNull();
  });
});
