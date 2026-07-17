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
  spyOn,
  test,
} from "bun:test";

const isLocalModeMock = mock(() => !process.env.VITE_PLATFORM_MODE);
const isPlatformDisabledMock = mock(() => false);
const isRemoteGatewayModeMock = mock(
  () => window.__VELLUM_CONFIG__?.mode === "remote-gateway",
);
mock.module("@/lib/local-mode", () => ({
  getActiveAssistant: () => undefined,
  getLocalAssistants: () => [],
  getLocalGatewayUrl: () => undefined,
  getLockfile: () => ({ assistants: [], activeAssistant: null }),
  getPlatformAssistants: () => [],
  getPlatformRuntimeUrl: () => window.location.origin,
  getSelectedAssistant: () => undefined,
  hasAssistants: () => false,
  isLocalAssistant: () => false,
  isLocalMode: isLocalModeMock,
  isPlatformDisabled: isPlatformDisabledMock,
  isPlatformAssistant: () => false,
  isRemoteGatewayMode: isRemoteGatewayModeMock,
  loadLockfile: async () => ({ assistants: [], activeAssistant: null }),
  primeLocalGatewayConnection: async () => {},
  primeLocalGatewayConnectionWithRepair: async () => {},
  reconcileSelectedAssistant: () => {},
  retireLocalAssistant: async () => ({ ok: false }),
  saveLockfileAssistant: async () => {},
  setActiveLockfileAssistant: async () => {},
  syncPlatformAssistantsToLockfile: async () => {},
}));

import {
  authorizeRemoteGatewayRequest,
  daemonErrorInterceptor,
  daemonRequestInterceptor,
  localGatewayAuthRecoveryInterceptor,
  platformFeaturesGate,
  requestInterceptor,
  resetGw401RecoveryFlag,
  rewriteForSelfHostedIngress,
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
    expect(headers.get("X-Vellum-Interface-Id")).toBe("web");
  });

  test("attaches X-Vellum-Client-Id and X-Vellum-Interface-Id on POST", async () => {
    const headers = await intercept("POST");
    expect(headers.get("X-Vellum-Client-Id")).toBe(getClientId());
    expect(headers.get("X-Vellum-Interface-Id")).toBe("web");
  });

  test("attaches client + interface headers on PUT, PATCH, DELETE", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const headers = await intercept(method);
      expect(headers.get("X-Vellum-Client-Id")).toBe(getClientId());
      expect(headers.get("X-Vellum-Interface-Id")).toBe("web");
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
// listed segments are rewritten. Platform-owned routes like
// `maintenance-mode/`, `system-events/`, `terminal/`,
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

  test("rewrites the live events SSE stream to the ingress", async () => {
    // The events stream opens through the platform client; in local /
    // self-hosted mode it must route to the gateway like conversations
    // rather than fall through to the platform proxy.
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const eventsPath = `/v1/assistants/${SELF_HOSTED_ID}/events/`;
    const input = new Request(
      `https://platform.test${eventsPath}?lastSeenSeq=42`,
    );
    const output = await requestInterceptor(input);
    const outUrl = new URL(output.url);
    expect(outUrl.origin).toBe(INGRESS);
    expect(outUrl.pathname).toBe(eventsPath);
    expect(outUrl.search).toBe("?lastSeenSeq=42");
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
  });

  test("rewrites user-defined route handler (`/x/`) calls to the ingress", async () => {
    // Sandboxed apps POST to their backend handlers under `/v1/x/*`
    // through the platform client; in local / self-hosted mode these
    // must route to the gateway rather than fall through to the
    // platform proxy.
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const userRoutePath = `/v1/assistants/${SELF_HOSTED_ID}/x/us-vs-the-world`;
    const input = new Request(`https://platform.test${userRoutePath}`, {
      method: "POST",
    });
    const output = await requestInterceptor(input);
    const outUrl = new URL(output.url);
    expect(outUrl.origin).toBe(INGRESS);
    expect(outUrl.pathname).toBe(userRoutePath);
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
  });

  test("rewrites daemon/gateway-owned segments reached via the platform client", async () => {
    // config is daemon-owned and still called through the platform client
    // via raw `client.*` requests (the background `TimezoneSync` PATCH).
    // In local / self-hosted mode it must route to the gateway like
    // conversations rather than fall through to the dead platform proxy
    // and flood the console with 502s. (artifacts is NOT listed — its
    // assistant-scoped routes aren't served by the gateway or daemon, so
    // forwarding it would only 404.)
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    for (const segment of ["config"]) {
      const path = `/v1/assistants/${SELF_HOSTED_ID}/${segment}/`;
      const input = new Request(`https://platform.test${path}`, {
        method: "POST",
      });
      const output = await requestInterceptor(input);
      const outUrl = new URL(output.url);
      expect(outUrl.origin).toBe(INGRESS);
      expect(outUrl.pathname).toBe(path);
      expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
    }
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
    expect(output.headers.get("X-Vellum-Interface-Id")).toBe("web");
  });

  test("rewrites assistant event routes to the self-hosted gateway", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(
      "https://platform.test/v1/assistants/self/events/",
    );
    const output = await requestInterceptor(input);
    expect(new URL(output.url).origin).toBe(INGRESS);
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
    expect(output.headers.get("Vellum-Organization-Id")).toBeNull();
    expect(output.headers.get("X-CSRFToken")).toBeNull();
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
    // The platform client's narrow allowlist ensures platform-owned routes
    // (and runtime routes not yet mirrored on the gateway) fall through
    // rather than being rewritten. Pin the non-rewriting contract for the
    // routes most likely to get mistakenly captured.
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
      "oauth",
      // `/a2a/invites/redeem` is a platform broker (Django) route.
      "a2a",
      // artifacts is daemon/gateway-owned but no gateway or daemon route
      // serves it, so it must NOT be rewritten — forwarding would 404
      // rather than reach a handler.
      "artifacts",
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
    expect(output.headers.get("X-Vellum-Interface-Id")).toBe("web");
  });
});

// ---------------------------------------------------------------------------
// Self-hosted contact-family flattening
// ---------------------------------------------------------------------------
//
// Contact-family paths (`contacts`, `contact-channels`) are forwarded to
// the ingress prefix-stripped — `/v1/assistants/{id}/<rest>` becomes
// `/v1/<rest>` — matching what cloud's Django RuntimeProxyView delivers
// to the gateway, which serves the family on its flat control-plane
// routes. Both interceptor entry points (platform client and daemon
// client) converge on the same flat path; every other segment keeps
// today's verbatim scoped forwarding.

const CONTACT_FLATTEN_CASES = [
  { method: "POST", scoped: "contacts", flat: "/v1/contacts" },
  {
    method: "DELETE",
    scoped: "contacts/contact-123",
    flat: "/v1/contacts/contact-123",
  },
  {
    method: "POST",
    scoped: "contacts/prompt/submit",
    flat: "/v1/contacts/prompt/submit",
  },
  { method: "POST", scoped: "contacts/merge", flat: "/v1/contacts/merge" },
  {
    method: "GET",
    scoped: "contacts/invites",
    flat: "/v1/contacts/invites",
  },
  {
    method: "DELETE",
    scoped: "contacts/invites/invite-456",
    flat: "/v1/contacts/invites/invite-456",
  },
  {
    method: "POST",
    scoped: "contact-channels/channel-abc/verify",
    flat: "/v1/contact-channels/channel-abc/verify",
  },
  {
    method: "PATCH",
    scoped: "contact-channels/channel-abc",
    flat: "/v1/contact-channels/channel-abc",
  },
] as const;

describe("api-interceptors / self-hosted contact-family flattening", () => {
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

  const ENTRY_POINTS = [
    ["platform client", requestInterceptor],
    ["daemon client", daemonRequestInterceptor],
  ] as const;

  for (const [label, interceptor] of ENTRY_POINTS) {
    test(`${label}: strips the assistant prefix from contact-family paths`, async () => {
      setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
      for (const { method, scoped, flat } of CONTACT_FLATTEN_CASES) {
        const input = new Request(
          `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/${scoped}`,
          { method },
        );
        const output = await interceptor(input);
        const outUrl = new URL(output.url);
        expect(outUrl.origin).toBe(INGRESS);
        expect(outUrl.pathname).toBe(flat);
        expect(output.headers.get("Authorization")).toBe(
          `Bearer ${ACTOR_TOKEN}`,
        );
        expect(output.headers.get("Vellum-Organization-Id")).toBeNull();
        expect(output.headers.get("X-CSRFToken")).toBeNull();
      }
    });

    test(`${label}: preserves the query string on flattened list requests`, async () => {
      setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
      const input = new Request(
        `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/contacts?query=x`,
      );
      const output = await interceptor(input);
      const outUrl = new URL(output.url);
      expect(outUrl.origin).toBe(INGRESS);
      expect(outUrl.pathname).toBe("/v1/contacts");
      expect(outUrl.search).toBe("?query=x");
    });
  }

  test("prepends the ingress path prefix to flattened paths", async () => {
    setSelfHostedConnection({
      url: "http://localhost:3000/__gateway/20100",
      token: ACTOR_TOKEN,
    });
    const input = new Request(
      `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/contacts`,
      { method: "POST" },
    );
    const output = await daemonRequestInterceptor(input);
    const outUrl = new URL(output.url);
    expect(outUrl.origin).toBe("http://localhost:3000");
    expect(outUrl.pathname).toBe("/__gateway/20100/v1/contacts");
  });

  test("non-contact segments keep the scoped path", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    for (const [interceptor, segment] of [
      [requestInterceptor, "conversations"],
      [requestInterceptor, "config"],
      [daemonRequestInterceptor, "skills"],
    ] as const) {
      const path = `/v1/assistants/${SELF_HOSTED_ID}/${segment}/`;
      const input = new Request(`https://platform.test${path}`);
      const output = await interceptor(input);
      const outUrl = new URL(output.url);
      expect(outUrl.origin).toBe(INGRESS);
      expect(outUrl.pathname).toBe(path);
    }
  });

  test("no ingress registered — rewrite returns null and the request is untouched", async () => {
    const scopedPath = `/v1/assistants/${SELF_HOSTED_ID}/contacts`;
    const input = new Request(`https://platform.test${scopedPath}`, {
      method: "POST",
    });
    expect(await rewriteForSelfHostedIngress(input)).toBeNull();
    expect(
      await rewriteForSelfHostedIngress(input, { skipSegmentAllowlist: true }),
    ).toBeNull();

    const output = await requestInterceptor(input);
    const outUrl = new URL(output.url);
    expect(outUrl.origin).toBe("https://platform.test");
    expect(outUrl.pathname).toBe(scopedPath);
  });
});

// ---------------------------------------------------------------------------
// Remote gateway direct requests
// ---------------------------------------------------------------------------
//
// Remote web serves the SPA from the same nginx edge as the gateway. Daemon and
// gateway generated clients can call flat same-origin `/v1/...` routes directly
// instead of `/v1/assistants/{id}/...`; those need the paired browser token too.

describe("api-interceptors / remote gateway direct requests", () => {
  beforeEach(() => {
    window.__VELLUM_CONFIG__ = { mode: "remote-gateway" };
    useOrganizationStore.setState({ currentOrganizationId: TEST_ORG_ID });
    setCsrfCookie("test-csrf-token");
  });

  afterEach(() => {
    window.__VELLUM_CONFIG__ = undefined;
    setSelfHostedConnection(null);
    clearCsrfCookie();
  });

  test("authorizes daemon same-origin flat /v1 requests with the paired browser token", async () => {
    setSelfHostedConnection({
      url: window.location.origin,
      token: ACTOR_TOKEN,
    });
    const input = new Request(
      `${window.location.origin}/v1/feature-flags`,
      { headers: { "Vellum-Organization-Id": TEST_ORG_ID } },
    );

    const output = await daemonRequestInterceptor(input);

    expect(output.url).toBe(input.url);
    expect(output.credentials).toBe("omit");
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
    expect(output.headers.get("Vellum-Organization-Id")).toBeNull();
    expect(output.headers.get("X-CSRFToken")).toBeNull();
    expect(output.headers.get("ngrok-skip-browser-warning")).toBe("true");
    expect(output.headers.get("X-Vellum-Client-Id")).toBe(getClientId());
  });

  test("adds the ngrok browser-warning bypass header to rewritten assistant routes", async () => {
    setSelfHostedConnection({
      url: window.location.origin,
      token: ACTOR_TOKEN,
    });
    const input = new Request(
      `${window.location.origin}/v1/assistants/self/messages?conversationId=conv-1`,
    );

    const output = await daemonRequestInterceptor(input);

    expect(output.url).toBe(input.url);
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
    expect(output.headers.get("ngrok-skip-browser-warning")).toBe("true");
  });

  test("preserves a remote ingress path prefix for flat /v1 requests", () => {
    setSelfHostedConnection({
      url: `${window.location.origin}/assistant-123`,
      token: ACTOR_TOKEN,
    });
    const input = new Request(
      `${window.location.origin}/assistant-123/v1/feature-flags`,
    );

    const output = authorizeRemoteGatewayRequest(input);

    expect(output?.url).toBe(input.url);
    expect(output?.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
  });

  test("does not authorize non-prefixed /v1 requests when the remote ingress is path-prefixed", () => {
    setSelfHostedConnection({
      url: `${window.location.origin}/assistant-123`,
      token: ACTOR_TOKEN,
    });
    const input = new Request(
      `${window.location.origin}/v1/feature-flags`,
    );

    expect(authorizeRemoteGatewayRequest(input)).toBeNull();
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
    window.__VELLUM_CONFIG__ = undefined;
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

  test("aborts platform requests in remote-gateway mode", () => {
    window.__VELLUM_CONFIG__ = { mode: "remote-gateway" };
    const input = new Request(
      `${window.location.origin}/v1/feature-flags/client-flag-values/`,
    );
    const output = platformFeaturesGate(input);
    expect(output.signal.aborted).toBe(true);
  });

  test("passes bearer-authenticated gateway requests in remote-gateway mode", () => {
    window.__VELLUM_CONFIG__ = { mode: "remote-gateway" };
    const input = new Request(
      `${window.location.origin}/v1/assistants/self/events/`,
      { headers: { Authorization: `Bearer ${ACTOR_TOKEN}` } },
    );
    const output = platformFeaturesGate(input);
    expect(output.signal.aborted).toBe(false);
    expect(output.url).toBe(input.url);
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

// ---------------------------------------------------------------------------
// Local gateway 401 auth recovery interceptor
// ---------------------------------------------------------------------------

// Gateway localStorage keys — referenced by variable so the AST-based
// no-restricted-syntax rule (which only matches literal key arguments)
// does not fire in test-only setItem calls.
const GW_TOKEN_KEYS = [
  "vellum:gw:token",
  "vellum:gw:expiresAt",
  "vellum:gw:tokenSource",
  "gw:token",
  "gw:expiresAt",
  "gw:tokenSource",
] as const;

function seedGatewayTokens(): void {
  const values: Record<string, string> = {
    "vellum:gw:token": "stale-jwt",
    // generic-examples:ignore-next-line — reason: Unix timestamp for token expiry, not a phone number
    "vellum:gw:expiresAt": "9999999999",
    "vellum:gw:tokenSource": "/auth/token",
    "gw:token": "legacy-jwt",
    // generic-examples:ignore-next-line — reason: Unix timestamp for token expiry, not a phone number
    "gw:expiresAt": "9999999999",
    "gw:tokenSource": "/auth/token",
  };
  for (const key of GW_TOKEN_KEYS) {
    localStorage.setItem(key, values[key]);
  }
}

function clearGatewayTokenStorage(): void {
  for (const key of GW_TOKEN_KEYS) {
    localStorage.removeItem(key);
  }
}

describe("api-interceptors / localGatewayAuthRecoveryInterceptor", () => {
  const GATEWAY_URL = "http://localhost:9090";
  const GW_401_RELOAD_KEY = "vellum:gw:401-reload-at";

  function makeResponse(status: number, url: string): Response {
    const response = new Response(null, { status });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }

  function gatewayResponse(status: number): Response {
    return makeResponse(status, GATEWAY_URL + "/v1/assistants/123/conversations");
  }

  let originalReload: typeof window.location.reload;
  let reloadCalls: number;

  beforeEach(() => {
    reloadCalls = 0;
    originalReload = window.location.reload;
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      value: mock(() => {
        reloadCalls += 1;
      }),
    });
    isLocalModeMock.mockImplementation(() => true);
    setSelfHostedConnection({ url: GATEWAY_URL, token: "tok" });
    sessionStorage.removeItem(GW_401_RELOAD_KEY);
    clearGatewayTokenStorage();
    resetGw401RecoveryFlag();
  });

  afterEach(() => {
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      value: originalReload,
    });
    isLocalModeMock.mockImplementation(() => !process.env.VITE_PLATFORM_MODE);
    setSelfHostedConnection(null);
    sessionStorage.removeItem(GW_401_RELOAD_KEY);
    clearGatewayTokenStorage();
    resetGw401RecoveryFlag();
  });

  test("clears gateway tokens and reloads on 401 from local gateway", () => {
    /**
     * Validates the core auth recovery: a stale gateway token triggers
     * a localStorage clear and page reload to acquire a fresh token.
     */

    // GIVEN gateway tokens are stored in localStorage
    seedGatewayTokens();

    // WHEN the daemon receives a 401 from the local gateway
    localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    // THEN all gateway token keys are cleared
    for (const key of GW_TOKEN_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
    }

    // AND the page reloads
    expect(reloadCalls).toBe(1);
  });

  test("does not reload on non-401 status codes", () => {
    /**
     * Validates that only 401 triggers recovery — other error codes
     * (like 502/503 handled by the unreachable interceptor) pass through.
     */

    // GIVEN a gateway token is stored
    const tokenKey = GW_TOKEN_KEYS[0];
    localStorage.setItem(tokenKey, "valid-jwt");

    // WHEN the daemon receives a 502 from the gateway
    localGatewayAuthRecoveryInterceptor(gatewayResponse(502));

    // THEN gateway tokens are untouched and no reload fires
    expect(localStorage.getItem(tokenKey)).toBe("valid-jwt");
    expect(reloadCalls).toBe(0);
  });

  test("does not reload when not in local mode", () => {
    /**
     * Validates that 401s from platform-hosted assistants are ignored —
     * they are handled by the auth store / allauth instead.
     */

    // GIVEN platform mode is active
    isLocalModeMock.mockImplementation(() => false);

    // WHEN the daemon receives a 401
    localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    // THEN no reload fires
    expect(reloadCalls).toBe(0);
  });

  test("does not reload when no self-hosted ingress URL is configured", () => {
    /**
     * Validates that 401s without a gateway connection configured
     * are ignored — they are handled by the auth store instead.
     */

    // GIVEN no ingress URL is configured
    setSelfHostedConnection(null);

    // WHEN the daemon receives a 401
    localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    // THEN no reload fires
    expect(reloadCalls).toBe(0);
  });

  test("does not reload when 401 originates from the platform, not the gateway", () => {
    /**
     * Validates that daemon requests which were NOT rewritten to the
     * gateway (e.g. non-assistant paths) don't trigger recovery.
     */

    // GIVEN the response URL does not match the gateway ingress
    const platformResponse = makeResponse(
      401,
      "https://api.vellum.ai/v1/some-platform-endpoint",
    );

    // WHEN the interceptor processes the 401
    localGatewayAuthRecoveryInterceptor(platformResponse);

    // THEN no reload fires
    expect(reloadCalls).toBe(0);
  });

  test("cooldown prevents infinite reload loops", () => {
    /**
     * Validates that a recent reload within the cooldown window
     * suppresses a second reload to prevent thrashing.
     */

    // GIVEN a reload already happened recently
    sessionStorage.setItem(GW_401_RELOAD_KEY, String(Date.now()));

    // WHEN the daemon receives another 401
    localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    // THEN no additional reload fires
    expect(reloadCalls).toBe(0);
  });

  test("cooldown expires and allows a fresh reload", () => {
    /**
     * Validates that once the cooldown window expires, a subsequent
     * 401 triggers another recovery attempt.
     */

    // GIVEN a reload happened over 10 minutes ago
    sessionStorage.setItem(GW_401_RELOAD_KEY, String(Date.now() - 700_000));
    seedGatewayTokens();

    // WHEN the daemon receives a 401
    localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    // THEN the page reloads again
    expect(reloadCalls).toBe(1);

    // AND gateway tokens are cleared
    for (const key of GW_TOKEN_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });

  test("skips reload when sessionStorage is unavailable", () => {
    /**
     * Validates that when sessionStorage throws (e.g. in a sandboxed
     * iframe or when storage quota is exceeded), the interceptor skips
     * reload rather than entering an infinite loop without cooldown.
     */

    // GIVEN sessionStorage is unavailable
    const originalGetItem = sessionStorage.getItem;
    Object.defineProperty(sessionStorage, "getItem", {
      configurable: true,
      value: () => {
        throw new DOMException("unavailable");
      },
    });

    // WHEN the daemon receives a 401 from the gateway
    localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    // THEN no reload fires (cooldown cannot be enforced)
    expect(reloadCalls).toBe(0);

    // cleanup
    Object.defineProperty(sessionStorage, "getItem", {
      configurable: true,
      value: originalGetItem,
    });
  });

  test("only fires once per page lifecycle even with concurrent 401s", () => {
    /**
     * Validates that when multiple in-flight requests all return 401
     * concurrently, only the first triggers clear+reload — the rest
     * are suppressed by the in-memory latch.
     */

    // GIVEN gateway tokens are stored
    seedGatewayTokens();

    // WHEN three concurrent 401s arrive from the gateway
    localGatewayAuthRecoveryInterceptor(gatewayResponse(401));
    localGatewayAuthRecoveryInterceptor(gatewayResponse(401));
    localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    // THEN only one reload fires
    expect(reloadCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Local-mode body buffering — large uploads must not stall
// ---------------------------------------------------------------------------
//
// Over plain HTTP the body can't stream (Chrome refuses a `duplex: "half"`
// body without TLS), so it's buffered. It MUST be buffered to a Blob, not an
// ArrayBuffer: an ArrayBuffer body is streamed to the network process through
// a fixed-capacity (~1-2 MB) data pipe, so a larger upload stalls forever when
// the local consumer (a busy dev server) drains the pipe slowly — the symptom
// being image/file uploads above ~1.5 MB hanging on "Stalled". A Blob is
// passed by reference (blob handle), so there is no renderer-side data pipe to
// block on. The preload sets VITE_PLATFORM_MODE=true; these tests clear it so
// isLocalMode() returns true and the buffering path runs.

describe("api-interceptors / local-mode body buffering", () => {
  let savedPlatformMode: string | undefined;

  beforeAll(() => {
    savedPlatformMode = process.env.VITE_PLATFORM_MODE;
    delete process.env.VITE_PLATFORM_MODE;
    useOrganizationStore.setState({ currentOrganizationId: TEST_ORG_ID });
  });

  afterAll(() => {
    if (savedPlatformMode !== undefined) {
      process.env.VITE_PLATFORM_MODE = savedPlatformMode;
    }
  });

  afterEach(() => {
    setSelfHostedConnection(null);
  });

  test("buffers the request body via .blob()", async () => {
    // .blob() yields a by-reference body; reverting to .arrayBuffer() (which
    // never calls .blob()) would fail this and reintroduce the >1.5 MB stall.
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const blobSpy = spyOn(Request.prototype, "blob");
    try {
      const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`, {
        method: "POST",
        body: "upload-payload",
      });
      await daemonRequestInterceptor(input);
      expect(blobSpy).toHaveBeenCalled();
    } finally {
      blobSpy.mockRestore();
    }
  });

  test("the rewritten request carries the buffered body content", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`, {
      method: "POST",
      body: "upload-payload",
    });
    const output = await daemonRequestInterceptor(input);
    expect(new URL(output.url).origin).toBe(INGRESS);
    expect(await output.text()).toBe("upload-payload");
  });

  test("a bodyless GET is rewritten without buffering", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const blobSpy = spyOn(Request.prototype, "blob");
    try {
      const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`);
      const output = await daemonRequestInterceptor(input);
      expect(new URL(output.url).origin).toBe(INGRESS);
      expect(blobSpy).not.toHaveBeenCalled();
    } finally {
      blobSpy.mockRestore();
    }
  });
});
