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
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const isPlatformDisabledMock = mock(() => false);
mock.module("@/lib/local-mode", () => ({
  isLocalMode: () => !process.env.VITE_PLATFORM_MODE,
  isPlatformDisabled: isPlatformDisabledMock,
}));

import {
  daemonErrorInterceptor,
  daemonRequestInterceptor,
  platformFeaturesGate,
  requestInterceptor,
} from "@/lib/api-interceptors";
import { ApiError } from "@/utils/api-errors";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import { getClientId } from "@/lib/telemetry/client-identity";
import { __resetForTesting as resetSessionToken } from "@/runtime/session-token";
import { useOrganizationStore } from "@/stores/organization-store";

const TEST_ORG_ID = "org-test-1234";
const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Vellum-Electron-Renderer-Origin";

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

  test("does not attach the session-token header on web (no Electron bridge)", async () => {
    const headers = await intercept("GET");
    expect(headers.get("X-Session-Token")).toBeNull();
  });

  test("does not attach renderer-origin marker outside Electron", async () => {
    const headers = await intercept("POST");
    expect(headers.get(ELECTRON_RENDERER_ORIGIN_HEADER)).toBeNull();
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

describe("api-interceptors / Electron session-token header", () => {
  beforeAll(() => {
    useOrganizationStore.setState({ currentOrganizationId: TEST_ORG_ID });
    setCsrfCookie("test-csrf-token");
  });

  beforeEach(() => {
    (window as unknown as { vellum?: unknown }).vellum = {
      platform: "electron",
      auth: { getSessionToken: () => "electron-sess-tok" },
    };
  });

  afterEach(() => {
    delete (window as unknown as { vellum?: unknown }).vellum;
    resetSessionToken();
  });

  afterAll(() => {
    clearCsrfCookie();
  });

  test("attaches the session-token header on platform requests", async () => {
    const headers = await intercept("GET");
    expect(headers.get("X-Session-Token")).toBe("electron-sess-tok");
  });

  test("drops CSRF on mutations — header auth, not cookie auth", async () => {
    const headers = await intercept("POST");
    expect(headers.get("X-Session-Token")).toBe("electron-sess-tok");
    expect(headers.get("X-CSRFToken")).toBeNull();
  });

  test("attaches renderer-origin marker on Electron mutating requests", async () => {
    const headers = await intercept("POST");
    expect(headers.get(ELECTRON_RENDERER_ORIGIN_HEADER)).toBe(
      `${window.location.protocol}//${window.location.host}`,
    );
  });

  test("does not attach renderer-origin marker on Electron safe requests", async () => {
    const headers = await intercept("GET");
    expect(headers.get(ELECTRON_RENDERER_ORIGIN_HEADER)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Self-hosted rewriting — platform client (requestInterceptor)
// ---------------------------------------------------------------------------
//
// When the assistant resolves to `{ kind: "self_hosted" }`, the lifecycle
// hook calls `setSelfHostedConnection({ url, token })`. From that point
// on, allowlisted runtime-proxied `/v1/assistants/{id}/<segment>/...`
// calls leave the platform's base URL behind and go directly to the
// user's gateway.
//
// The platform client uses the segment allowlist — only explicitly
// listed segments (currently `conversations`) are rewritten. Platform-
// owned routes like `maintenance-mode/`, `system-events/`, `terminal/`,
// `doctor/` fall through to Django.
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

  test("prepends the ingress path prefix when the ingress URL has a path", async () => {
    const prefixedIngress = "http://localhost:3000/__gateway/20100";
    setSelfHostedConnection({ url: prefixedIngress, token: ACTOR_TOKEN });
    const input = new Request(
      `https://platform.test/v1/assistants/self/conversations`,
    );
    const output = await requestInterceptor(input);
    const outUrl = new URL(output.url);
    expect(outUrl.origin).toBe("http://localhost:3000");
    expect(outUrl.pathname).toBe(
      "/__gateway/20100/v1/assistants/self/conversations",
    );
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
    // The platform client's narrow allowlist ensures platform-owned
    // routes fall through to Django. Pin the non-rewriting contract
    // for the routes most likely to get mistakenly captured.
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

// ---------------------------------------------------------------------------
// Self-hosted rewriting — daemon client (daemonRequestInterceptor)
// ---------------------------------------------------------------------------
//
// The daemon client bypasses the segment allowlist entirely. Every
// daemon SDK request is a daemon route by definition, so all assistant
// sub-resource paths are forwarded to the self-hosted gateway.
//
// This means daemon SDK calls for skills, plugins, memories, etc. are
// correctly routed even though they're not in RUNTIME_PROXIED_FIRST_SEGMENTS.

const DAEMON_SKILLS_PATH = `/v1/assistants/${SELF_HOSTED_ID}/skills/`;
const DAEMON_PLUGINS_PATH = `/v1/assistants/${SELF_HOSTED_ID}/plugins/`;
const DAEMON_MEMORY_PATH = `/v1/assistants/${SELF_HOSTED_ID}/memory-items/`;

describe("api-interceptors / daemon client self-hosted rewriting", () => {
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

  test("rewrites daemon paths that are NOT in the platform allowlist", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    for (const path of [DAEMON_SKILLS_PATH, DAEMON_PLUGINS_PATH, DAEMON_MEMORY_PATH]) {
      const input = new Request(`https://platform.test${path}`);
      const output = await daemonRequestInterceptor(input);
      const outUrl = new URL(output.url);
      expect(outUrl.origin).toBe(INGRESS);
      expect(outUrl.pathname).toBe(path);
      expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
      expect(output.headers.get("Vellum-Organization-Id")).toBeNull();
      expect(output.headers.get("X-CSRFToken")).toBeNull();
    }
  });

  test("rewrites allowlisted paths too (conversations)", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`);
    const output = await daemonRequestInterceptor(input);
    expect(new URL(output.url).origin).toBe(INGRESS);
  });

  test("falls through to platform dressing when no connection is set", async () => {
    const input = new Request(`https://platform.test${DAEMON_SKILLS_PATH}`, {
      method: "POST",
    });
    const output = await daemonRequestInterceptor(input);
    expect(new URL(output.url).origin).toBe("https://platform.test");
    expect(output.headers.get("Vellum-Organization-Id")).toBe(TEST_ORG_ID);
    expect(output.headers.get("X-CSRFToken")).toBe("test-csrf-token");
  });

  test("does NOT rewrite the bare retrieve route", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(
      `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/`,
    );
    const output = await daemonRequestInterceptor(input);
    // Bare retrieve has no sub-resource segment — regex doesn't match.
    expect(new URL(output.url).origin).toBe("https://platform.test");
  });

  test("preserves client + interface identity headers", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${DAEMON_SKILLS_PATH}`);
    const output = await daemonRequestInterceptor(input);
    expect(output.headers.get("X-Vellum-Client-Id")).toBe(getClientId());
    expect(output.headers.get("X-Vellum-Interface-Id")).toBe("vellum");
  });
});

// ---------------------------------------------------------------------------
// Platform features gate
// ---------------------------------------------------------------------------
//
// In local mode with platform features disabled, the abort interceptor
// must NOT kill requests already rewritten to the self-hosted gateway.
//
// The test preload sets VITE_PLATFORM_MODE=true (platform mode).
// These tests temporarily clear it so isLocalMode() returns true.

describe("api-interceptors / platform features gate", () => {
  let savedPlatformMode: string | undefined;

  beforeAll(() => {
    savedPlatformMode = process.env.VITE_PLATFORM_MODE;
    delete process.env.VITE_PLATFORM_MODE;
  });

  afterAll(() => {
    if (savedPlatformMode !== undefined) {
      process.env.VITE_PLATFORM_MODE = savedPlatformMode;
    }
  });

  afterEach(() => {
    setSelfHostedConnection(null);
    isPlatformDisabledMock.mockImplementation(() => false);
  });

  test("aborts platform-bound requests when platform is disabled", () => {
    isPlatformDisabledMock.mockImplementation(() => true);
    const input = new Request("https://platform.test/v1/organizations/");
    const output = platformFeaturesGate(input);
    expect(output.signal.aborted).toBe(true);
  });

  test("passes through gateway-rewritten requests when platform is disabled", () => {
    isPlatformDisabledMock.mockImplementation(() => true);
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    // Simulate a request already rewritten to the gateway by requestInterceptor
    const input = new Request(`${INGRESS}${DAEMON_SKILLS_PATH}`);
    const output = platformFeaturesGate(input);
    expect(output.signal.aborted).toBe(false);
    expect(output.url).toBe(input.url);
  });

  test("passes through all requests when platform is not disabled", () => {
    isPlatformDisabledMock.mockImplementation(() => false);
    const input = new Request("https://platform.test/v1/organizations/");
    const output = platformFeaturesGate(input);
    expect(output.signal.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Daemon error interceptor — ApiError normalization
// ---------------------------------------------------------------------------

describe("api-interceptors / daemonErrorInterceptor", () => {
  const throwing = { throwOnError: true as const };
  const nonThrowing = { throwOnError: false as const };

  test("wraps plain-object errors from non-OK responses into ApiError", () => {
    const body = { detail: "Service unavailable" };
    const response = new Response(null, { status: 503 });
    const result = daemonErrorInterceptor(body, response, undefined, throwing);
    expect(result).toBeInstanceOf(ApiError);
    expect((result as ApiError).status).toBe(503);
    expect((result as ApiError).message).toBe("Service unavailable");
  });

  test("wraps string errors into ApiError", () => {
    const body = "Bad Gateway";
    const response = new Response(null, { status: 502 });
    const result = daemonErrorInterceptor(body, response, undefined, throwing);
    expect(result).toBeInstanceOf(ApiError);
    expect((result as ApiError).status).toBe(502);
    expect((result as ApiError).message).toBe("Bad Gateway");
  });

  test("passes through existing ApiError instances unchanged", () => {
    const existing = new ApiError(401, "Unauthorized");
    const response = new Response(null, { status: 401 });
    const result = daemonErrorInterceptor(existing, response, undefined, throwing);
    expect(result).toBe(existing);
  });

  test("passes through errors with no response (network failures)", () => {
    const networkError = new TypeError("fetch failed");
    const result = daemonErrorInterceptor(networkError, undefined, undefined, throwing);
    expect(result).toBe(networkError);
  });

  test("passes through errors when response is OK", () => {
    const body = { detail: "unexpected" };
    const response = new Response(null, { status: 200 });
    const result = daemonErrorInterceptor(body, response, undefined, throwing);
    expect(result).toBe(body);
  });

  test("extracts Organization-Id message for 400 errors", () => {
    const body = { detail: "Organization-Id header is required" };
    const response = new Response(null, { status: 400 });
    const result = daemonErrorInterceptor(body, response, undefined, throwing);
    expect(result).toBeInstanceOf(ApiError);
    expect((result as ApiError).status).toBe(400);
    expect((result as ApiError).message).toBe("Organization-Id header is required");
  });

  test("preserves raw error body when throwOnError is false", () => {
    const body = { accepted: false, error: "secret_blocked", message: "Missing API key" };
    const response = new Response(null, { status: 422 });
    const result = daemonErrorInterceptor(body, response, undefined, nonThrowing);
    expect(result).toBe(body);
    expect(result).not.toBeInstanceOf(ApiError);
  });

  test("preserves raw error body when throwOnError is undefined", () => {
    const body = { detail: "Something went wrong" };
    const response = new Response(null, { status: 500 });
    const result = daemonErrorInterceptor(body, response, undefined, {});
    expect(result).toBe(body);
    expect(result).not.toBeInstanceOf(ApiError);
  });
});
