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
import type * as LocalMode from "@/lib/local-mode";
import type { LockfileAssistant } from "@/runtime/local-mode-host";
import type * as CaptureError from "@/lib/sentry/capture-error";
import type * as RemoteGatewaySession from "@/lib/auth/remote-gateway-session";

const isLocalClientMock = mock(() => !process.env.VITE_PLATFORM_MODE);
const isPlatformDisabledMock = mock(() => false);
const isRemoteGatewayModeMock = mock(
  () => window.__VELLUM_CONFIG__?.mode === "remote-gateway",
);
let primeGatewayWithRepairImpl: () => Promise<void> = async () => {};
const primeGatewayWithRepairMock = mock(() => primeGatewayWithRepairImpl());
// The lockfile selection the recovery snapshots; a test moves it to model an
// assistant switch or logout landing while the re-prime is in flight.
let selectedAssistantImpl: () => LockfileAssistant | undefined = () =>
  undefined;
mock.module(
  "@/lib/local-mode",
  (): Partial<typeof LocalMode> => ({
    getActiveAssistant: () => undefined,
    getLocalAssistants: () => [],
    getLocalGatewayUrl: () => undefined,
    getLockfile: () => ({ assistants: [], activeAssistant: null }),
    getPlatformAssistants: () => [],
    getPlatformRuntimeUrl: () => window.location.origin,
    getSelectedAssistant: () => selectedAssistantImpl(),
    hasAssistants: () => false,
    isLocalAssistant: () => false,
    isLocalClient: isLocalClientMock,
    isPlatformDisabled: isPlatformDisabledMock,
    isPlatformAssistant: () => false,
    isRemoteGatewayMode: isRemoteGatewayModeMock,
    loadLockfile: async () => ({ assistants: [], activeAssistant: null }),
    primeLocalGatewayConnection: async () => {},
    primeLocalGatewayConnectionWithRepair: primeGatewayWithRepairMock,
    reconcileSelectedAssistant: () => {},
    retireLocalAssistant: async () => ({ ok: false }),
    saveLockfileAssistant: async () => {},
    setActiveLockfileAssistant: async () => {},
    syncPlatformAssistantsToLockfile: async () => {},
  }),
);

// Auth store — mocked so the interceptor's `useAuthStore.getState()` reads a
// controllable `sessionStatus` + `refreshSession` without pulling in the real
// store's heavy dependency graph. `subscribe` is a no-op the (unrelated)
// organization-store binds but never calls in these tests.
type MockSessionStatus = "initializing" | "authenticated" | "unauthenticated";
type MockPlatformSession = "unknown" | "present" | "absent";

const mockAuthState: {
  sessionStatus: MockSessionStatus;
  platformSession: MockPlatformSession;
  refreshSession: () => Promise<boolean>;
} = {
  sessionStatus: "authenticated",
  platformSession: "present",
  refreshSession: async () => true,
};

// Controls the probe-settle wait the recovery path awaits after
// `refreshSession`. Defaults to already-settled; a test swaps in a pending
// promise to model the fire-and-forget probe still being in flight.
let whenPlatformSessionSettledImpl: () => Promise<void> = async () => {};
const whenPlatformSessionSettledMock = mock(() =>
  whenPlatformSessionSettledImpl(),
);

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => mockAuthState,
    subscribe: () => () => {},
  },
  whenPlatformSessionSettled: whenPlatformSessionSettledMock,
}));

const hardNavigateMock = mock((_url: string) => {});
mock.module("@/lib/auth/hard-navigate", () => ({
  hardNavigate: hardNavigateMock,
}));

// Sentry capture, stubbed so a failed in-place recovery doesn't touch the
// real client and the capture can be asserted.
const captureErrorMock = mock((_err: unknown, _ctx?: unknown) => {});
mock.module(
  "@/lib/sentry/capture-error",
  (): Partial<typeof CaptureError> => ({
    captureError: captureErrorMock,
  }),
);

// Paired-browser refresh, stubbed so remote-gateway recovery is driven
// without a live pairing cookie; a test flips it to model a rejected refresh.
let refreshRemoteGatewaySessionImpl: () => Promise<boolean> = async () => true;
const refreshRemoteGatewaySessionMock = mock((_opts?: { force?: boolean }) =>
  refreshRemoteGatewaySessionImpl(),
);
mock.module(
  "@/lib/auth/remote-gateway-session",
  (): Partial<typeof RemoteGatewaySession> => ({
    refreshRemoteGatewaySession: refreshRemoteGatewaySessionMock,
  }),
);

// Post-resume request counter, stubbed so a test can make it throw and prove
// the interceptor still returns its request. `isResumeWindowOpen` defaults to
// true so counting is exercised; a test flips it to pin the idle fast path.
let noteDaemonApiRequestImpl: (url: string) => void = () => {};
let resumeWindowOpen = true;
const noteDaemonApiRequestMock = mock((url: string) => {
  noteDaemonApiRequestImpl(url);
});
const isResumeWindowOpenMock = mock(() => resumeWindowOpen);
// `installResumeRequestCounter` is stubbed for surface parity only. The module
// under test calls it at module scope, and ESM imports are hoisted above these
// `mock.module` calls, so that one call already ran against the real
// implementation before the stub took over. It subscribes to the bus and
// nothing here publishes to it.
mock.module("@/lib/telemetry/resume-request-counter", () => ({
  __resetResumeRequestCounterForTests: () => {},
  installResumeRequestCounter: () => {},
  isResumeWindowOpen: isResumeWindowOpenMock,
  noteDaemonApiRequest: noteDaemonApiRequestMock,
}));

import { client as platformClient } from "@/generated/api/client.gen";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import { client as gatewayClient } from "@/generated/gateway/client.gen";
import {
  authorizeRemoteGatewayRequest,
  daemonErrorInterceptor,
  daemonRequestInterceptor,
  localGatewayAuthRecoveryInterceptor,
  platformAuthRecoveryInterceptor,
  platformFeaturesGate,
  requestInterceptor,
  resetGw401RecoveryState,
  resetPlatformAuthRecoveryFlag,
  rewriteForSelfHostedIngress,
} from "@/lib/api-interceptors";
import { GatewayTokenError, getGatewayToken } from "@/lib/auth/gateway-session";
import { subscribe } from "@/lib/event-bus";
import { ApiError } from "@/utils/api-errors";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
  setSelfHostedConnection,
} from "@/lib/self-hosted/connection";
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

async function intercept(
  method: string,
  url = "https://example.test/v1/probe",
) {
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
    const input = new Request("https://example.test/v1/probe", {
      method: "POST",
    });
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
    const input = new Request(
      `https://platform.test${RUNTIME_PROXIED_PATH}?limit=50`,
    );
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
    for (const path of [
      DAEMON_SKILLS_PATH,
      DAEMON_PLUGINS_PATH,
      DAEMON_MEMORY_PATH,
    ]) {
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
    const input = new Request(`${window.location.origin}/v1/feature-flags`, {
      headers: { "Vellum-Organization-Id": TEST_ORG_ID },
    });

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
    const input = new Request(`${window.location.origin}/v1/feature-flags`);

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
// These tests temporarily clear it so isLocalClient() returns true.

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
    expect((output.signal.reason as DOMException).message).toBe(
      "Platform features disabled in local mode",
    );
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
    expect((output.signal.reason as DOMException).message).toBe(
      "Platform routes disabled in remote-gateway mode",
    );
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
    const result = daemonErrorInterceptor(
      existing,
      response,
      undefined,
      throwing,
    );
    expect(result).toBe(existing);
  });

  test("passes through errors with no response (network failures)", () => {
    const networkError = new TypeError("fetch failed");
    const result = daemonErrorInterceptor(
      networkError,
      undefined,
      undefined,
      throwing,
    );
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
    expect((result as ApiError).message).toBe(
      "Organization-Id header is required",
    );
  });

  test("preserves raw error body when throwOnError is false", () => {
    const body = {
      accepted: false,
      error: "secret_blocked",
      message: "Missing API key",
    };
    const response = new Response(null, { status: 422 });
    const result = daemonErrorInterceptor(
      body,
      response,
      undefined,
      nonThrowing,
    );
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

describe("api-interceptors / recovery interceptor registration", () => {
  // Direct calls to the interceptor prove what it does, not where it runs.
  // These pin which generated clients actually carry it, so adding or
  // dropping a registration has to be deliberate.
  function responseFns(c: {
    interceptors: { response: unknown };
  }): readonly unknown[] {
    const chain = c.interceptors.response as unknown as { fns?: unknown[] };
    return chain.fns ?? [];
  }

  test("daemonClient carries the local-gateway 401 recovery", () => {
    expect(responseFns(daemonClient)).toContain(
      localGatewayAuthRecoveryInterceptor,
    );
  });

  test("gatewayClient carries it too", () => {
    // Both clients are rewritten to the same ingress, so a stale renderer
    // token 401s them identically and both must heal in place.
    expect(responseFns(gatewayClient)).toContain(
      localGatewayAuthRecoveryInterceptor,
    );
  });

  test("the platform client does not carry it", () => {
    // Platform 401s are session rejections owned by the platform recovery,
    // and gateway-origin responses reaching that client are its own guard's
    // job to leave alone.
    expect(responseFns(platformClient)).not.toContain(
      localGatewayAuthRecoveryInterceptor,
    );
  });
});

describe("api-interceptors / localGatewayAuthRecoveryInterceptor", () => {
  const GATEWAY_URL = "http://localhost:9090";
  const GW_401_RECOVERY_AT_KEY = "vellum:gw:401-reload-at";
  const GW_401_ATTEMPTS_KEY = "vellum:gw:401-reload-attempts";
  const GW_401_MAX_ATTEMPTS = 3;

  function makeResponse(status: number, url: string): Response {
    const response = new Response(null, { status });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }

  function gatewayResponse(status: number): Response {
    return makeResponse(
      status,
      GATEWAY_URL + "/v1/assistants/123/conversations",
    );
  }

  /** A gateway-bound GET whose (empty) body is always replayable. */
  /**
   * A gateway-bound GET that went out with the bearer the slot holds now
   * and came back 401: the shape that needs a recovery.
   */
  function gatewayGet(): Request {
    return new Request(GATEWAY_URL + "/v1/assistants/123/conversations", {
      headers: { Authorization: "Bearer tok" },
    });
  }

  /**
   * A gateway-bound GET built before the slot moved on: its bearer no
   * longer matches, so it is replayable without a recovery.
   */
  function staleBearerGet(): Request {
    return new Request(GATEWAY_URL + "/v1/assistants/123/conversations", {
      headers: { Authorization: "Bearer superseded-tok" },
    });
  }

  /**
   * A gateway-bound POST whose body fetch has already consumed, the shape
   * of the chat send the moment its 401 reaches this interceptor.
   */
  async function consumedPost(): Promise<Request> {
    const request = new Request(
      GATEWAY_URL + "/v1/assistants/123/conversations/abc/messages",
      {
        method: "POST",
        body: "hello",
        headers: { Authorization: "Bearer tok" },
      },
    );
    await request.text();
    return request;
  }

  let originalReload: typeof window.location.reload;
  let reloadCalls: number;
  // Publishes of the guardian-repair handoff during the test that is running.
  let repairRequests: number;
  let unsubscribeRepairRequests: () => void;
  let originalFetch: typeof globalThis.fetch;
  let replayedRequests: Request[];

  beforeEach(() => {
    reloadCalls = 0;
    repairRequests = 0;
    unsubscribeRepairRequests = subscribe(
      "gateway.guardian-repair-required",
      () => {
        repairRequests += 1;
      },
    );
    originalReload = window.location.reload;
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      value: mock(() => {
        reloadCalls += 1;
      }),
    });
    isLocalClientMock.mockImplementation(() => true);
    setSelfHostedConnection({ url: GATEWAY_URL, token: "tok" });
    sessionStorage.removeItem(GW_401_RECOVERY_AT_KEY);
    sessionStorage.removeItem(GW_401_ATTEMPTS_KEY);
    clearGatewayTokenStorage();
    resetGw401RecoveryState();
    primeGatewayWithRepairMock.mockClear();
    refreshRemoteGatewaySessionMock.mockClear();
    refreshRemoteGatewaySessionImpl = async () => true;
    captureErrorMock.mockClear();
    // Model the real prime: a fresh token lands in the connection slot.
    primeGatewayWithRepairImpl = async () => {
      setSelfHostedConnection({ url: GATEWAY_URL, token: "fresh-tok" });
    };
    replayedRequests = [];
    originalFetch = globalThis.fetch;
    // The replay is a bare fetch by design (no client under it), so fetch
    // is the boundary here; the built Request is captured so its headers
    // can still be asserted.
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      replayedRequests.push(input as Request);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    unsubscribeRepairRequests();
    globalThis.fetch = originalFetch;
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      value: originalReload,
    });
    isLocalClientMock.mockImplementation(() => !process.env.VITE_PLATFORM_MODE);
    isRemoteGatewayModeMock.mockImplementation(
      () => window.__VELLUM_CONFIG__?.mode === "remote-gateway",
    );
    setSelfHostedConnection(null);
    sessionStorage.removeItem(GW_401_RECOVERY_AT_KEY);
    sessionStorage.removeItem(GW_401_ATTEMPTS_KEY);
    clearGatewayTokenStorage();
    resetGw401RecoveryState();
    primeGatewayWithRepairImpl = async () => {};
    selectedAssistantImpl = () => undefined;
  });

  test("recovers the session in place on 401, never reloading the page", async () => {
    /**
     * Validates the core auth recovery: a rejected gateway token triggers
     * an in-place forced re-mint. Reloading here would eat the in-flight
     * mutation and the composer state with no error shown, so the page
     * must never reload.
     */

    // GIVEN gateway tokens are stored in localStorage
    seedGatewayTokens();

    // WHEN the daemon receives a 401 from the local gateway
    const response = gatewayResponse(401);
    const result = await localGatewayAuthRecoveryInterceptor(response);

    // THEN the session is re-primed with a forced mint
    expect(primeGatewayWithRepairMock).toHaveBeenCalledTimes(1);
    expect(primeGatewayWithRepairMock).toHaveBeenCalledWith(undefined, {
      forceMint: true,
    });

    // AND the page never reloads; without a replayable request the 401
    // flows back to the caller's error path
    expect(reloadCalls).toBe(0);
    expect(result).toBe(response);
  });

  test("the rejected token stays in place until its replacement is minted", async () => {
    /**
     * A recovery must not null the cached token while the mint is in
     * flight: `isGatewayAuthMode()` reads it, and a session refresh or a
     * lifecycle pass landing in that window would take the platform
     * branch and could log a local-gateway user out.
     */

    // GIVEN gateway tokens are stored, and a prime that inspects them
    seedGatewayTokens();
    let tokenDuringPrime: string | null | undefined;
    primeGatewayWithRepairImpl = async () => {
      tokenDuringPrime = localStorage.getItem("vellum:gw:token");
      setSelfHostedConnection({ url: GATEWAY_URL, token: "fresh-tok" });
    };

    // WHEN a 401 triggers recovery
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    // THEN the token was still present throughout the mint
    expect(tokenDuringPrime).toBe("stale-jwt");
  });

  test("replays a request whose bearer the slot has already moved past, without recovering", async () => {
    /**
     * A 401 whose request carries a superseded bearer was built before a
     * recovery (or any re-prime) that has since completed. The session is
     * already healthy, so it replays straight away: no recovery, no budget.
     */

    // WHEN a superseded-bearer GET's 401 reaches the interceptor
    const result = await localGatewayAuthRecoveryInterceptor(
      gatewayResponse(401),
      staleBearerGet(),
    );

    // THEN it is replayed with the slot's current bearer, with no recovery
    expect(replayedRequests).toHaveLength(1);
    expect(replayedRequests[0].headers.get("Authorization")).toBe("Bearer tok");
    expect(result.status).toBe(200);
    expect(primeGatewayWithRepairMock).not.toHaveBeenCalled();

    // AND no budget was spent
    expect(sessionStorage.getItem(GW_401_ATTEMPTS_KEY)).toBeNull();
  });

  test("a straggler that 401s after the recovery settled is replayed, not refused", async () => {
    // GIVEN a recovery that has already run and moved the slot to a fresh
    // token, writing the cooldown timestamp as it went
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(401));
    expect(getSelfHostedActorToken()).toBe("fresh-tok");
    replayedRequests = [];

    // WHEN a request that went out with the old token comes back 401
    const straggler = new Request(
      GATEWAY_URL + "/v1/assistants/123/conversations",
      { headers: { Authorization: "Bearer tok" } },
    );
    const result = await localGatewayAuthRecoveryInterceptor(
      gatewayResponse(401),
      straggler,
    );

    // THEN it rides the healthy session instead of hitting the cooldown
    expect(result.status).toBe(200);
    expect(replayedRequests[0].headers.get("Authorization")).toBe(
      "Bearer fresh-tok",
    );
    expect(primeGatewayWithRepairMock).toHaveBeenCalledTimes(1);
  });

  test("remote-gateway mode refreshes the paired session in place", async () => {
    /**
     * A paired browser session has a refresh cookie; a rejected access
     * token is exchanged for a new one without leaving the page.
     */

    // GIVEN remote-gateway mode and a refresh that lands a new token
    isRemoteGatewayModeMock.mockImplementation(() => true);
    refreshRemoteGatewaySessionImpl = async () => {
      setSelfHostedConnection({ url: GATEWAY_URL, token: "fresh-tok" });
      return true;
    };

    // WHEN a gateway GET's 401 reaches the interceptor
    const result = await localGatewayAuthRecoveryInterceptor(
      gatewayResponse(401),
      gatewayGet(),
    );

    // THEN the refresh was forced and the request replayed on the new token
    expect(refreshRemoteGatewaySessionMock).toHaveBeenCalledWith({
      force: true,
    });
    expect(replayedRequests[0].headers.get("Authorization")).toBe(
      "Bearer fresh-tok",
    );
    expect(result.status).toBe(200);
    expect(reloadCalls).toBe(0);
    expect(primeGatewayWithRepairMock).not.toHaveBeenCalled();
  });

  test("replays a bodyless request with the re-primed bearer", async () => {
    /**
     * Validates that a background read never surfaces the transient 401:
     * after recovery the request is re-issued with the fresh token and the
     * fresh response is returned in its place.
     */

    // WHEN a gateway GET's 401 reaches the interceptor
    const result = await localGatewayAuthRecoveryInterceptor(
      gatewayResponse(401),
      gatewayGet(),
    );

    // THEN the request is replayed carrying the re-primed bearer
    expect(replayedRequests).toHaveLength(1);
    expect(replayedRequests[0].headers.get("Authorization")).toBe(
      "Bearer fresh-tok",
    );

    // AND the replay's response is returned in place of the 401
    expect(result.status).toBe(200);
    expect(reloadCalls).toBe(0);
  });

  test("a replayed 2xx restores the budget", async () => {
    /**
     * The replay's success is a real 2xx from the ingress, but it returns
     * from inside this interceptor and never re-enters the chain, so it
     * must restore the budget itself. Otherwise a quiet app accrues one
     * spent attempt per recovered episode and eventually stops recovering.
     */

    // WHEN a 401 recovers and the replay succeeds
    await localGatewayAuthRecoveryInterceptor(
      gatewayResponse(401),
      gatewayGet(),
    );

    // THEN the attempt spent on the recovery is restored
    expect(sessionStorage.getItem(GW_401_ATTEMPTS_KEY)).toBeNull();
    expect(sessionStorage.getItem(GW_401_RECOVERY_AT_KEY)).toBeNull();
  });

  test("hands the 401 back when the replay itself fails to complete", async () => {
    // GIVEN the network drops between recovery and replay
    globalThis.fetch = mock(async () => {
      throw new TypeError("network down");
    }) as unknown as typeof globalThis.fetch;

    // WHEN a replayable request's 401 reaches the interceptor
    const response = gatewayResponse(401);
    const result = await localGatewayAuthRecoveryInterceptor(
      response,
      gatewayGet(),
    );

    // THEN the caller gets the original 401, not a new failure shape
    expect(result).toBe(response);
  });

  test("hands the 401 back for a request whose body is consumed", async () => {
    /**
     * The chat send POST cannot be replayed here (fetch consumed its body),
     * so its 401 must flow back to the send path, whose failure handling
     * surfaces the error and keeps the message retryable. Recovery still
     * runs so that retry rides the fresh token.
     */

    // WHEN a consumed POST's 401 reaches the interceptor
    const response = gatewayResponse(401);
    const result = await localGatewayAuthRecoveryInterceptor(
      response,
      await consumedPost(),
    );

    // THEN recovery ran, but the 401 is handed back without a replay
    expect(primeGatewayWithRepairMock).toHaveBeenCalledTimes(1);
    expect(replayedRequests).toHaveLength(0);
    expect(result).toBe(response);
    expect(reloadCalls).toBe(0);
  });

  test("hands the 401 back when recovery fails, and captures the failure", async () => {
    // GIVEN the gateway rejects the fresh mint too
    primeGatewayWithRepairImpl = async () => {
      throw new Error("mint rejected");
    };

    // WHEN a 401 reaches the interceptor
    const response = gatewayResponse(401);
    const result = await localGatewayAuthRecoveryInterceptor(
      response,
      gatewayGet(),
    );

    // THEN the 401 flows to the error path, without replay or reload
    expect(result).toBe(response);
    expect(replayedRequests).toHaveLength(0);
    expect(reloadCalls).toBe(0);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });

  test("hands a session needing a guardian repair to the chooser", async () => {
    /**
     * A mint the gateway still answers with 401 after the wake the repair
     * ran needs a guardian re-provision, which no automatic path performs.
     * Leaving the cached token in place is what makes it survive a
     * relaunch: its local expiry still looks fine, so the reconnect reuses
     * it instead of minting and lands straight back in the dead session.
     */

    // GIVEN a cached token the gateway refuses past the wake
    seedGatewayTokens();
    primeGatewayWithRepairImpl = async () => {
      throw new GatewayTokenError(401, "Gateway token request failed: 401");
    };

    // WHEN a 401 reaches the interceptor
    const response = gatewayResponse(401);
    const result = await localGatewayAuthRecoveryInterceptor(
      response,
      gatewayGet(),
    );

    // THEN nothing is left for the reconnect to replay
    expect(getGatewayToken()).toBeNull();
    // AND the chooser is asked for the repair it alone offers
    expect(repairRequests).toBe(1);
    // AND the 401 still flows to the caller's error path, no reload
    expect(result).toBe(response);
    expect(reloadCalls).toBe(0);
  });

  test("a repair verdict from a superseded assistant leaves the live session alone", async () => {
    /**
     * The wake and its retries take seconds, and a switch or a logout can
     * land inside that window. The verdict is then about an assistant
     * nobody is connected to, so acting on it would clear the gateway token
     * the newly selected one is using and route the user away from it.
     */

    // GIVEN a recovery for one assistant, and a switch mid-prime
    seedGatewayTokens();
    selectedAssistantImpl = () => ({ assistantId: "asst-a", cloud: "local" });
    primeGatewayWithRepairImpl = async () => {
      selectedAssistantImpl = () => ({ assistantId: "asst-b", cloud: "local" });
      throw new GatewayTokenError(401, "Gateway token request failed: 401");
    };

    // WHEN the superseded recovery fails repairably
    await localGatewayAuthRecoveryInterceptor(
      gatewayResponse(401),
      gatewayGet(),
    );

    // THEN the token the new selection may already hold survives
    expect(getGatewayToken()).toBe("stale-jwt");
    // AND the user is not routed away from it
    expect(repairRequests).toBe(0);
  });

  test("re-arms recovery once a reconnect installs a fresh bearer", async () => {
    /**
     * The local path never reloads, so a completed repair reconnects inside
     * the same page lifecycle. A latch that outlived the bearer it was set
     * for would leave the repaired session with no recovery at all for as
     * long as the app stays open.
     */

    // GIVEN a session handed off for a guardian repair
    primeGatewayWithRepairImpl = async () => {
      throw new GatewayTokenError(401, "Gateway token request failed: 401");
    };
    await localGatewayAuthRecoveryInterceptor(
      gatewayResponse(401),
      gatewayGet(),
    );
    expect(primeGatewayWithRepairMock).toHaveBeenCalledTimes(1);

    // WHEN the repair reconnects with a fresh bearer and the gateway serves it
    setSelfHostedConnection({ url: GATEWAY_URL, token: "repaired-tok" });
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(200));
    primeGatewayWithRepairImpl = async () => {
      setSelfHostedConnection({ url: GATEWAY_URL, token: "fresh-tok" });
    };

    // AND that later session is rejected in its turn
    await localGatewayAuthRecoveryInterceptor(
      gatewayResponse(401),
      new Request(GATEWAY_URL + "/v1/assistants/123/conversations", {
        headers: { Authorization: "Bearer repaired-tok" },
      }),
    );

    // THEN recovery runs for it instead of staying latched off
    expect(primeGatewayWithRepairMock).toHaveBeenCalledTimes(2);
  });

  test("stops recovering once a guardian repair is required", async () => {
    /**
     * The budget alone does not bound this: any 2xx from the ingress
     * refunds it, so a gateway serving its own routes while rejecting a
     * proxied one re-arms recovery indefinitely and the health poll
     * re-enters a repair that cannot succeed, every few seconds, for the
     * life of the session.
     */

    // GIVEN a session that needs a repair the renderer cannot run
    primeGatewayWithRepairImpl = async () => {
      throw new GatewayTokenError(401, "Gateway token request failed: 401");
    };

    // WHEN a 401 gives up, an ingress 2xx refunds the budget, and
    // another 401 arrives
    await localGatewayAuthRecoveryInterceptor(
      gatewayResponse(401),
      gatewayGet(),
    );
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(200));
    await localGatewayAuthRecoveryInterceptor(
      gatewayResponse(401),
      gatewayGet(),
    );

    // THEN the repair ran once and was asked for once
    expect(primeGatewayWithRepairMock).toHaveBeenCalledTimes(1);
    expect(repairRequests).toBe(1);
  });

  test("a failed recovery restores the connection slot the prime nulled", async () => {
    /**
     * The paired branch of primeLocalGatewayConnection clears the slot
     * when its readyz probe fails. Without the restore, a failed recovery
     * strands the renderer with no ingress route, and this interceptor
     * (which matches on the ingress URL) could never fire again.
     */

    // GIVEN a prime that dies after clearing the slot, as the paired
    // branch does when the readyz probe fails
    primeGatewayWithRepairImpl = async () => {
      setSelfHostedConnection(null);
      throw new Error("readyz failed");
    };

    // WHEN a 401 reaches the interceptor and recovery fails
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    // THEN the pre-recovery connection is back in the slot
    expect(getSelfHostedIngressUrl()).toBe(GATEWAY_URL);
    expect(getSelfHostedActorToken()).toBe("tok");
  });

  test("a failed recovery leaves the slot alone once the selection has moved", async () => {
    /**
     * A switch to a platform assistant, or a logout, clears the slot
     * legitimately while the re-prime is in flight. Restoring the old
     * ingress then would route the new selection's requests to the old
     * local gateway, so the restore is gated on the selection the
     * recovery started for.
     */

    // GIVEN the recovery started for assistant A
    selectedAssistantImpl = () => ({ assistantId: "asst-a", cloud: "local" });

    // AND, mid-prime, the selection moves to a platform assistant and the
    // lifecycle clears the slot, then the prime fails
    primeGatewayWithRepairImpl = async () => {
      selectedAssistantImpl = () => ({
        assistantId: "asst-platform",
        cloud: "vellum",
      });
      setSelfHostedConnection(null);
      throw new Error("readyz failed");
    };

    // WHEN a 401 reaches the interceptor and recovery fails
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    // THEN the old assistant's ingress is NOT put back
    expect(getSelfHostedIngressUrl()).toBeNull();
    expect(getSelfHostedActorToken()).toBeNull();
  });

  test("remote-gateway mode reloads only when the refresh cookie is rejected too", async () => {
    /**
     * A paired session whose refresh is refused cannot be revived from the
     * renderer, so it boots into the pairing flow. This is the one reload
     * left, and it is budgeted like every other attempt.
     */

    // GIVEN remote-gateway mode and a rejected refresh
    isRemoteGatewayModeMock.mockImplementation(() => true);
    refreshRemoteGatewaySessionImpl = async () => false;
    seedGatewayTokens();

    // WHEN the gateway rejects with 401
    const response = gatewayResponse(401);
    const result = await localGatewayAuthRecoveryInterceptor(
      response,
      gatewayGet(),
    );

    // THEN the page reloads and the 401 flows back without a replay
    expect(reloadCalls).toBe(1);
    expect(replayedRequests).toHaveLength(0);
    expect(result).toBe(response);
    expect(primeGatewayWithRepairMock).not.toHaveBeenCalled();
    for (const key of GW_TOKEN_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });

  test("does not recover on non-401 status codes", async () => {
    /**
     * Validates that only 401 triggers recovery: other error codes
     * (like 502/503 handled by the unreachable interceptor) pass through.
     */

    // GIVEN a gateway token is stored
    const tokenKey = GW_TOKEN_KEYS[0];
    localStorage.setItem(tokenKey, "valid-jwt");

    // WHEN the daemon receives a 502 from the gateway
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(502));

    // THEN gateway tokens are untouched and no recovery runs
    expect(localStorage.getItem(tokenKey)).toBe("valid-jwt");
    expect(primeGatewayWithRepairMock).not.toHaveBeenCalled();
    expect(reloadCalls).toBe(0);
  });

  test("does not recover when not in local mode", async () => {
    /**
     * Validates that 401s from platform-hosted assistants are ignored;
     * they are handled by the auth store / allauth instead.
     */

    // GIVEN platform mode is active
    isLocalClientMock.mockImplementation(() => false);

    // WHEN the daemon receives a 401
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    // THEN no recovery runs
    expect(primeGatewayWithRepairMock).not.toHaveBeenCalled();
    expect(reloadCalls).toBe(0);
  });

  test("does not recover when no self-hosted ingress URL is configured", async () => {
    /**
     * Validates that 401s without a gateway connection configured
     * are ignored; they are handled by the auth store instead.
     */

    // GIVEN no ingress URL is configured
    setSelfHostedConnection(null);

    // WHEN the daemon receives a 401
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    // THEN no recovery runs
    expect(primeGatewayWithRepairMock).not.toHaveBeenCalled();
    expect(reloadCalls).toBe(0);
  });

  test("does not recover when 401 originates from the platform, not the gateway", async () => {
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
    await localGatewayAuthRecoveryInterceptor(platformResponse);

    // THEN no recovery runs
    expect(primeGatewayWithRepairMock).not.toHaveBeenCalled();
    expect(reloadCalls).toBe(0);
  });

  test("cooldown prevents recovery storms", async () => {
    /**
     * Validates that a recent recovery attempt within the cooldown window
     * suppresses a second one to prevent mint storms against a gateway
     * that rejects every token.
     */

    // GIVEN a recovery attempt already happened recently
    sessionStorage.setItem(GW_401_RECOVERY_AT_KEY, String(Date.now()));

    // WHEN the daemon receives another 401
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    // THEN no additional recovery runs
    expect(primeGatewayWithRepairMock).not.toHaveBeenCalled();
  });

  test("cooldown expires and allows a fresh recovery", async () => {
    /**
     * Validates that once the cooldown window expires, a subsequent
     * 401 triggers another recovery attempt.
     */

    // GIVEN a recovery attempt happened over 10 minutes ago
    sessionStorage.setItem(
      GW_401_RECOVERY_AT_KEY,
      String(Date.now() - 700_000),
    );
    // WHEN the daemon receives a 401
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    // THEN the session recovers again
    expect(primeGatewayWithRepairMock).toHaveBeenCalledTimes(1);
  });

  test("skips recovery when sessionStorage is unavailable", async () => {
    /**
     * Validates that when sessionStorage throws (e.g. in a sandboxed
     * iframe or when storage quota is exceeded), the interceptor skips
     * recovery rather than entering an unbounded loop without cooldown.
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
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    // THEN no recovery runs (cooldown cannot be enforced)
    expect(primeGatewayWithRepairMock).not.toHaveBeenCalled();

    // cleanup
    Object.defineProperty(sessionStorage, "getItem", {
      configurable: true,
      value: originalGetItem,
    });
  });

  test("a concurrent burst funds one recovery and replays every bodyless request", async () => {
    /**
     * Validates the single-flight slot: when multiple in-flight requests
     * all return 401 concurrently, one recovery runs, every caller rides
     * it, and each replayable request is re-issued afterwards.
     */

    // GIVEN a recovery that stays in flight until released
    let releasePrime!: () => void;
    primeGatewayWithRepairImpl = () =>
      new Promise<void>((resolve) => {
        releasePrime = () => {
          setSelfHostedConnection({ url: GATEWAY_URL, token: "fresh-tok" });
          resolve();
        };
      });

    // WHEN two 401s arrive while the recovery is still in flight
    const first = localGatewayAuthRecoveryInterceptor(
      gatewayResponse(401),
      gatewayGet(),
    );
    const second = localGatewayAuthRecoveryInterceptor(
      gatewayResponse(401),
      gatewayGet(),
    );
    releasePrime();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // THEN one recovery ran and both requests were replayed against it
    expect(primeGatewayWithRepairMock).toHaveBeenCalledTimes(1);
    expect(replayedRequests).toHaveLength(2);
    expect(firstResult.status).toBe(200);
    expect(secondResult.status).toBe(200);
  });

  test("stops recovering once the attempt budget is spent", async () => {
    // Each round models the cooldown having elapsed, so only the budget
    // can stop the attempts.
    for (let i = 0; i < GW_401_MAX_ATTEMPTS; i++) {
      sessionStorage.setItem(
        GW_401_RECOVERY_AT_KEY,
        String(Date.now() - 700_000),
      );
      await localGatewayAuthRecoveryInterceptor(gatewayResponse(401));
    }
    expect(primeGatewayWithRepairMock).toHaveBeenCalledTimes(
      GW_401_MAX_ATTEMPTS,
    );

    sessionStorage.setItem(
      GW_401_RECOVERY_AT_KEY,
      String(Date.now() - 700_000),
    );
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    expect(primeGatewayWithRepairMock).toHaveBeenCalledTimes(
      GW_401_MAX_ATTEMPTS,
    );
  });

  test("hands the 401 back unchanged once the budget is spent", async () => {
    sessionStorage.setItem(GW_401_ATTEMPTS_KEY, String(GW_401_MAX_ATTEMPTS));
    const response = gatewayResponse(401);

    expect(await localGatewayAuthRecoveryInterceptor(response)).toBe(response);
    expect(primeGatewayWithRepairMock).not.toHaveBeenCalled();
  });

  test("a quiet gap alone does not restore the budget", async () => {
    // A gateway that is still rejecting every token must not earn a fresh
    // budget out of a lull in traffic, or it retries forever in bursts.
    sessionStorage.setItem(GW_401_ATTEMPTS_KEY, String(GW_401_MAX_ATTEMPTS));
    sessionStorage.setItem(
      GW_401_RECOVERY_AT_KEY,
      String(Date.now() - 86_400_000),
    );

    await localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    expect(primeGatewayWithRepairMock).not.toHaveBeenCalled();
  });

  test("a successful gateway response restores the budget", async () => {
    sessionStorage.setItem(GW_401_ATTEMPTS_KEY, String(GW_401_MAX_ATTEMPTS));
    sessionStorage.setItem(
      GW_401_RECOVERY_AT_KEY,
      String(Date.now() - 700_000),
    );

    await localGatewayAuthRecoveryInterceptor(gatewayResponse(200));

    expect(sessionStorage.getItem(GW_401_ATTEMPTS_KEY)).toBeNull();
    expect(sessionStorage.getItem(GW_401_RECOVERY_AT_KEY)).toBeNull();
  });

  test("recovery, then a later failure episode, gets a full budget", async () => {
    // Episode one exhausts the budget.
    for (let i = 0; i < GW_401_MAX_ATTEMPTS + 1; i++) {
      sessionStorage.setItem(
        GW_401_RECOVERY_AT_KEY,
        String(Date.now() - 700_000),
      );
      await localGatewayAuthRecoveryInterceptor(gatewayResponse(401));
    }
    expect(primeGatewayWithRepairMock).toHaveBeenCalledTimes(
      GW_401_MAX_ATTEMPTS,
    );

    // The gateway starts working again.
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(200));

    // A genuinely new episode later gets its own budget.
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    expect(primeGatewayWithRepairMock).toHaveBeenCalledTimes(
      GW_401_MAX_ATTEMPTS + 1,
    );
  });

  test("a non-gateway 2xx does not restore the budget", async () => {
    sessionStorage.setItem(GW_401_ATTEMPTS_KEY, String(GW_401_MAX_ATTEMPTS));

    await localGatewayAuthRecoveryInterceptor(
      makeResponse(200, "https://api.vellum.ai/v1/whatever"),
    );

    expect(sessionStorage.getItem(GW_401_ATTEMPTS_KEY)).toBe(
      String(GW_401_MAX_ATTEMPTS),
    );
  });

  test("a fresh renderer session grants a new budget", async () => {
    sessionStorage.setItem(GW_401_ATTEMPTS_KEY, String(GW_401_MAX_ATTEMPTS));
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(401));
    expect(primeGatewayWithRepairMock).not.toHaveBeenCalled();

    // Quitting and reopening the app ends the renderer session, which is
    // what clearing sessionStorage models here.
    sessionStorage.removeItem(GW_401_ATTEMPTS_KEY);
    sessionStorage.removeItem(GW_401_RECOVERY_AT_KEY);
    resetGw401RecoveryState();
    await localGatewayAuthRecoveryInterceptor(gatewayResponse(401));

    expect(primeGatewayWithRepairMock).toHaveBeenCalledTimes(1);
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
// isLocalClient() returns true and the buffering path runs.

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
      const input = new Request(
        `https://platform.test${RUNTIME_PROXIED_PATH}`,
        {
          method: "POST",
          body: "upload-payload",
        },
      );
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

// ---------------------------------------------------------------------------
// Platform session mid-use expiry recovery interceptor
// ---------------------------------------------------------------------------
//
// When a cookie-authenticated request comes back 401/403/410 while the app
// still believes it is signed in, the interceptor re-verifies the session via
// `refreshSession` and, when it is truly gone, hard-navigates to login.
// Self-hosted / remote-gateway bearer 401s are left to
// `localGatewayAuthRecoveryInterceptor`.

describe("api-interceptors / platformAuthRecoveryInterceptor", () => {
  const PLATFORM_URL = "https://platform.test/v1/assistants/123/messages";
  const LOGIN_PREFIX = "/account/login?returnTo=";

  function makeResponse(status: number, url: string): Response {
    const response = new Response(null, { status });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }

  // The interceptor kicks off recovery fire-and-forget; flush the microtask
  // queue so the async `refreshSession` + redirect settle before asserting.
  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  const PLATFORM_AUTH_REDIRECT_KEY = "vellum:platform:auth-redirect-attempts";
  const PLATFORM_AUTH_MAX_REDIRECTS = 3;
  const PLATFORM_RECOVERY_AT_KEY = "vellum:platform:recovery-attempt-at";
  const PLATFORM_RECOVERY_ATTEMPTS_KEY = "vellum:platform:recovery-attempts";
  const PLATFORM_RECOVERY_PATH_KEY = "vellum:platform:recovery-path";
  const PLATFORM_RECOVERY_MAX_ATTEMPTS = 3;

  /**
   * Backdate the recovery cooldown so the next rejection is outside the
   * window. Tests that exercise the latch or the redirect budget across
   * multiple cycles use this to keep the cooldown out of the picture.
   */
  function expireRecoveryCooldown(): void {
    sessionStorage.setItem(
      PLATFORM_RECOVERY_AT_KEY,
      String(Date.now() - 700_000),
    );
  }

  /**
   * refreshSession that never confirms the session live (the probe lands on
   * "unknown"), so the claim it answers is not refunded.
   */
  function armUnrefundedRefresh() {
    const refreshSession = mock(async () => {
      mockAuthState.platformSession = "unknown";
      return true;
    });
    mockAuthState.refreshSession = refreshSession;
    return refreshSession;
  }

  beforeEach(() => {
    resetPlatformAuthRecoveryFlag();
    setSelfHostedConnection(null);
    sessionStorage.removeItem(PLATFORM_AUTH_REDIRECT_KEY);
    sessionStorage.removeItem(PLATFORM_RECOVERY_AT_KEY);
    sessionStorage.removeItem(PLATFORM_RECOVERY_ATTEMPTS_KEY);
    sessionStorage.removeItem(PLATFORM_RECOVERY_PATH_KEY);
    mockAuthState.sessionStatus = "authenticated";
    mockAuthState.platformSession = "present";
    mockAuthState.refreshSession = mock(async () => true);
    whenPlatformSessionSettledImpl = async () => {};
    hardNavigateMock.mockClear();
  });

  afterEach(() => {
    resetPlatformAuthRecoveryFlag();
    setSelfHostedConnection(null);
    sessionStorage.removeItem(PLATFORM_AUTH_REDIRECT_KEY);
    sessionStorage.removeItem(PLATFORM_RECOVERY_AT_KEY);
    sessionStorage.removeItem(PLATFORM_RECOVERY_ATTEMPTS_KEY);
    sessionStorage.removeItem(PLATFORM_RECOVERY_PATH_KEY);
    whenPlatformSessionSettledImpl = async () => {};
  });

  /** Drive one full rejection→recovery round trip against a dead session. */
  const rejectOnce = async (): Promise<void> => {
    mockAuthState.sessionStatus = "authenticated";
    mockAuthState.refreshSession = mock(async () => {
      mockAuthState.sessionStatus = "unauthenticated";
      return false;
    });
    // Keep the recovery cooldown and budget out of redirect-budget tests:
    // each round models a fresh, allowed recovery cycle.
    expireRecoveryCooldown();
    sessionStorage.removeItem(PLATFORM_RECOVERY_ATTEMPTS_KEY);
    sessionStorage.removeItem(PLATFORM_RECOVERY_PATH_KEY);
    platformAuthRecoveryInterceptor(makeResponse(401, PLATFORM_URL));
    await flush();
  };

  test("401 while authenticated re-verifies; a dead session redirects to login", async () => {
    const refreshSession = mock(async () => {
      mockAuthState.sessionStatus = "unauthenticated";
      return false;
    });
    mockAuthState.refreshSession = refreshSession;

    const response = makeResponse(401, PLATFORM_URL);
    expect(platformAuthRecoveryInterceptor(response)).toBe(response);
    await flush();

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(hardNavigateMock).toHaveBeenCalledTimes(1);
    expect(hardNavigateMock.mock.calls[0][0].startsWith(LOGIN_PREFIX)).toBe(
      true,
    );
  });

  test("403 that leaves the session live does not redirect and reopens the latch", async () => {
    const refreshSession = mock(async () => true); // session stays authenticated
    mockAuthState.refreshSession = refreshSession;

    platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
    await flush();

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(hardNavigateMock).not.toHaveBeenCalled();

    // Latch reopened → a later genuine rejection (outside the cooldown
    // window) triggers another re-probe.
    expireRecoveryCooldown();
    platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
    await flush();
    expect(refreshSession).toHaveBeenCalledTimes(2);
  });

  test("non-rejection statuses (200, 502) are no-ops", async () => {
    const refreshSession = mock(async () => true);
    mockAuthState.refreshSession = refreshSession;

    platformAuthRecoveryInterceptor(makeResponse(200, PLATFORM_URL));
    platformAuthRecoveryInterceptor(makeResponse(502, PLATFORM_URL));
    await flush();

    expect(refreshSession).not.toHaveBeenCalled();
    expect(hardNavigateMock).not.toHaveBeenCalled();
  });

  test("does nothing when the app is not authenticated at entry", async () => {
    const refreshSession = mock(async () => false);
    mockAuthState.refreshSession = refreshSession;

    for (const status of ["initializing", "unauthenticated"] as const) {
      mockAuthState.sessionStatus = status;
      platformAuthRecoveryInterceptor(makeResponse(401, PLATFORM_URL));
    }
    await flush();

    expect(refreshSession).not.toHaveBeenCalled();
    expect(hardNavigateMock).not.toHaveBeenCalled();
  });

  test("ignores a self-hosted gateway 401 — deferred to the gateway handler", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const refreshSession = mock(async () => false);
    mockAuthState.refreshSession = refreshSession;

    platformAuthRecoveryInterceptor(
      makeResponse(401, `${INGRESS}/v1/assistants/123/messages`),
    );
    await flush();

    expect(refreshSession).not.toHaveBeenCalled();
    expect(hardNavigateMock).not.toHaveBeenCalled();
  });

  test("a second rejection while recovery is in-flight is a no-op (one refreshSession)", async () => {
    let resolveRefresh: (value: boolean) => void = () => {};
    const refreshSession = mock(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    mockAuthState.refreshSession = refreshSession;

    platformAuthRecoveryInterceptor(makeResponse(401, PLATFORM_URL));
    platformAuthRecoveryInterceptor(makeResponse(401, PLATFORM_URL));

    // Latch set synchronously on the first hit → the second short-circuits.
    expect(refreshSession).toHaveBeenCalledTimes(1);

    resolveRefresh(true);
    await flush();
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  test("stops redirecting to login once the budget is spent", async () => {
    // The redirect is a full page load, so the in-memory latch cannot count
    // round trips and a bouncing destination would drive them without bound.
    for (let i = 0; i < PLATFORM_AUTH_MAX_REDIRECTS; i++) {
      await rejectOnce();
    }
    expect(hardNavigateMock).toHaveBeenCalledTimes(PLATFORM_AUTH_MAX_REDIRECTS);

    await rejectOnce();
    expect(hardNavigateMock).toHaveBeenCalledTimes(PLATFORM_AUTH_MAX_REDIRECTS);
  });

  test("a platform 2xx on a confirmed session restores the redirect budget", async () => {
    sessionStorage.setItem(
      PLATFORM_AUTH_REDIRECT_KEY,
      String(PLATFORM_AUTH_MAX_REDIRECTS),
    );

    await rejectOnce();
    expect(hardNavigateMock).not.toHaveBeenCalled();

    mockAuthState.platformSession = "present";
    platformAuthRecoveryInterceptor(makeResponse(200, PLATFORM_URL));
    expect(sessionStorage.getItem(PLATFORM_AUTH_REDIRECT_KEY)).toBeNull();

    await rejectOnce();
    expect(hardNavigateMock).toHaveBeenCalledTimes(1);
  });

  test("a 2xx without a platform session does not restore the budget", async () => {
    // The platform serves some routes to anonymous visitors, and the login
    // screen loads one: `AccountLayout` syncs client feature flags. Treating
    // that as proof of a live session would refill the budget on every bounce.
    mockAuthState.platformSession = "absent";
    sessionStorage.setItem(
      PLATFORM_AUTH_REDIRECT_KEY,
      String(PLATFORM_AUTH_MAX_REDIRECTS),
    );

    platformAuthRecoveryInterceptor(
      makeResponse(200, "https://platform.test/v1/feature-flags/"),
    );

    expect(sessionStorage.getItem(PLATFORM_AUTH_REDIRECT_KEY)).toBe(
      String(PLATFORM_AUTH_MAX_REDIRECTS),
    );
  });

  test("a self-hosted gateway 2xx does not restore the platform budget", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    mockAuthState.platformSession = "present";
    sessionStorage.setItem(
      PLATFORM_AUTH_REDIRECT_KEY,
      String(PLATFORM_AUTH_MAX_REDIRECTS),
    );

    platformAuthRecoveryInterceptor(
      makeResponse(200, `${INGRESS}/v1/assistants/123/messages`),
    );

    expect(sessionStorage.getItem(PLATFORM_AUTH_REDIRECT_KEY)).toBe(
      String(PLATFORM_AUTH_MAX_REDIRECTS),
    );
  });

  test("holds the latch until the platform probe settles", async () => {
    // `refreshSession` in gateway-auth mode fire-and-forgets the platform
    // probe, whose own requests 403 against a half-dead cookie. Those
    // rejections arrive after `refreshSession` resolved; if the latch were
    // already released, each would start the next recovery cycle.
    let settleProbe: () => void = () => {};
    whenPlatformSessionSettledImpl = () =>
      new Promise((resolve) => {
        settleProbe = resolve;
      });
    const refreshSession = mock(async () => true);
    mockAuthState.refreshSession = refreshSession;

    platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
    await flush();
    expect(refreshSession).toHaveBeenCalledTimes(1);

    // A probe-spawned 403 during the settle window must not recover again.
    expireRecoveryCooldown();
    platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
    await flush();
    expect(refreshSession).toHaveBeenCalledTimes(1);

    // Once the probe settles the latch reopens for a later genuine cycle.
    whenPlatformSessionSettledImpl = async () => {};
    settleProbe();
    await flush();
    expireRecoveryCooldown();
    platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
    await flush();
    expect(refreshSession).toHaveBeenCalledTimes(2);
  });

  test("a settled-absent platform session never triggers recovery", async () => {
    mockAuthState.platformSession = "absent";
    const refreshSession = mock(async () => true);
    mockAuthState.refreshSession = refreshSession;

    platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
    await flush();

    expect(refreshSession).not.toHaveBeenCalled();
    expect(hardNavigateMock).not.toHaveBeenCalled();
  });

  test("an unsettled (unknown) platform session does not recover", async () => {
    // While platformSession is "unknown" the boot probe is already evaluating
    // this same rejection evidence, so spending a claim here would only nest
    // a redundant refreshSession cycle on every dead-cookie boot.
    mockAuthState.platformSession = "unknown";
    const refreshSession = mock(async () => true);
    mockAuthState.refreshSession = refreshSession;

    platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
    await flush();

    expect(refreshSession).not.toHaveBeenCalled();
    expect(hardNavigateMock).not.toHaveBeenCalled();
  });

  test("a second rejection inside the cooldown window does not recover", async () => {
    const refreshSession = mock(async () => true);
    mockAuthState.refreshSession = refreshSession;

    platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
    await flush();
    expect(refreshSession).toHaveBeenCalledTimes(1);

    // Latch is reopened, but the attempt timestamp is fresh.
    platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
    await flush();
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  test("stops recovering once the attempt budget is spent", async () => {
    // The cap's defended scenario: re-probes that repeatedly fail to confirm
    // the session live never refund the count, so the budget binds. Each
    // cycle claims while the session still reads "present".
    const refreshSession = armUnrefundedRefresh();

    // Each round expires the cooldown so only the budget can stop it.
    for (let i = 0; i < PLATFORM_RECOVERY_MAX_ATTEMPTS + 1; i++) {
      mockAuthState.platformSession = "present";
      expireRecoveryCooldown();
      platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
      await flush();
    }
    expect(refreshSession).toHaveBeenCalledTimes(
      PLATFORM_RECOVERY_MAX_ATTEMPTS,
    );
  });

  test("a live-confirmed recovery refunds the count but keeps the cooldown", async () => {
    // platformSession stays "present" (beforeEach default): the probe keeps
    // confirming the session is live, so a route-level permission 403 must
    // not eat the budget a later real expiry needs.
    const refreshSession = mock(async () => true);
    mockAuthState.refreshSession = refreshSession;

    for (let i = 0; i < PLATFORM_RECOVERY_MAX_ATTEMPTS + 2; i++) {
      expireRecoveryCooldown();
      platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
      await flush();
    }

    // Every cycle recovered: the count was refunded each time.
    expect(refreshSession).toHaveBeenCalledTimes(
      PLATFORM_RECOVERY_MAX_ATTEMPTS + 2,
    );
    expect(sessionStorage.getItem(PLATFORM_RECOVERY_ATTEMPTS_KEY)).toBeNull();
    // The refund also drops the remembered pathname; a leftover key would
    // re-seed the outstanding flag after a reload and let a heal clear the
    // retained cooldown.
    expect(sessionStorage.getItem(PLATFORM_RECOVERY_PATH_KEY)).toBeNull();

    // The cooldown survives the refund: an immediate rejection stays paced.
    platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
    await flush();
    expect(refreshSession).toHaveBeenCalledTimes(
      PLATFORM_RECOVERY_MAX_ATTEMPTS + 2,
    );

    // With no remembered pathname, a later 2xx on that route cannot clear
    // the cooldown the refund kept.
    platformAuthRecoveryInterceptor(makeResponse(200, PLATFORM_URL));
    expect(sessionStorage.getItem(PLATFORM_RECOVERY_AT_KEY)).not.toBeNull();
  });

  test("a 2xx on the rejected route restores the recovery budget", async () => {
    // Unrefunded claims keep the budget spent, so only the heal can clear it.
    const refreshSession = armUnrefundedRefresh();

    platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
    await flush();
    expect(refreshSession).toHaveBeenCalledTimes(1);

    // Inside the cooldown a rejection cannot recover.
    mockAuthState.platformSession = "present";
    platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
    await flush();
    expect(refreshSession).toHaveBeenCalledTimes(1);

    // The same route succeeding is proof it healed; the cooldown clears and
    // the next rejection may recover immediately.
    platformAuthRecoveryInterceptor(makeResponse(200, PLATFORM_URL));
    expect(sessionStorage.getItem(PLATFORM_RECOVERY_ATTEMPTS_KEY)).toBeNull();
    expect(sessionStorage.getItem(PLATFORM_RECOVERY_AT_KEY)).toBeNull();

    platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
    await flush();
    expect(refreshSession).toHaveBeenCalledTimes(2);
  });

  test("an unrelated platform 2xx leaves an outstanding claim; the rejected route's clears it", async () => {
    const refreshSession = armUnrefundedRefresh();

    platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
    await flush();
    expect(refreshSession).toHaveBeenCalledTimes(1);

    // A route the platform serves without the session (feature-flag polling)
    // keeps succeeding; it must not clear the cooldown or the count.
    platformAuthRecoveryInterceptor(
      makeResponse(200, "https://platform.test/v1/client-feature-flags/"),
    );
    expect(sessionStorage.getItem(PLATFORM_RECOVERY_AT_KEY)).not.toBeNull();
    expect(sessionStorage.getItem(PLATFORM_RECOVERY_ATTEMPTS_KEY)).toBe("1");

    // The rejected route healing clears the whole bound.
    platformAuthRecoveryInterceptor(makeResponse(200, PLATFORM_URL));
    expect(sessionStorage.getItem(PLATFORM_RECOVERY_AT_KEY)).toBeNull();
    expect(sessionStorage.getItem(PLATFORM_RECOVERY_ATTEMPTS_KEY)).toBeNull();
    expect(sessionStorage.getItem(PLATFORM_RECOVERY_PATH_KEY)).toBeNull();
  });

  test("a refund resets the outstanding claim, so a later matching 2xx keeps the cooldown", async () => {
    // Default refreshSession confirms the session live, so the claim is
    // refunded and no heal is outstanding.
    platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
    await flush();
    expect(sessionStorage.getItem(PLATFORM_RECOVERY_ATTEMPTS_KEY)).toBeNull();

    // The matching 2xx must not clear the retained cooldown that paces
    // re-probing while the permission 403 persists.
    platformAuthRecoveryInterceptor(makeResponse(200, PLATFORM_URL));
    expect(sessionStorage.getItem(PLATFORM_RECOVERY_AT_KEY)).not.toBeNull();
  });

  test("a self-hosted gateway 2xx does not restore the recovery budget", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    sessionStorage.setItem(
      PLATFORM_RECOVERY_ATTEMPTS_KEY,
      String(PLATFORM_RECOVERY_MAX_ATTEMPTS),
    );

    platformAuthRecoveryInterceptor(
      makeResponse(200, `${INGRESS}/v1/assistants/123/messages`),
    );

    expect(sessionStorage.getItem(PLATFORM_RECOVERY_ATTEMPTS_KEY)).toBe(
      String(PLATFORM_RECOVERY_MAX_ATTEMPTS),
    );
  });

  test("skips recovery when sessionStorage is unavailable", async () => {
    // Without storage neither the cooldown nor the budget can be enforced,
    // so recovery fails closed rather than looping uncountably.
    const refreshSession = mock(async () => true);
    mockAuthState.refreshSession = refreshSession;
    const originalGetItem = sessionStorage.getItem;
    Object.defineProperty(sessionStorage, "getItem", {
      configurable: true,
      value: () => {
        throw new DOMException("unavailable");
      },
    });

    try {
      platformAuthRecoveryInterceptor(makeResponse(403, PLATFORM_URL));
      await flush();
    } finally {
      Object.defineProperty(sessionStorage, "getItem", {
        configurable: true,
        value: originalGetItem,
      });
    }

    expect(refreshSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Post-resume request counting
// ---------------------------------------------------------------------------

describe("api-interceptors / post-resume request counting", () => {
  beforeEach(() => {
    noteDaemonApiRequestMock.mockClear();
    isResumeWindowOpenMock.mockClear();
    noteDaemonApiRequestImpl = () => {};
    resumeWindowOpen = true;
  });

  afterEach(() => {
    noteDaemonApiRequestImpl = () => {};
    resumeWindowOpen = true;
    setSelfHostedConnection(null);
    window.__VELLUM_CONFIG__ = undefined;
    isLocalClientMock.mockImplementation(() => !process.env.VITE_PLATFORM_MODE);
    isPlatformDisabledMock.mockImplementation(() => false);
  });

  test("notes daemon requests", async () => {
    const url = "https://platform.test/v1/assistants/a1/conversations";
    await daemonRequestInterceptor(new Request(url));
    expect(noteDaemonApiRequestMock).toHaveBeenCalledTimes(1);
    expect(noteDaemonApiRequestMock.mock.calls.at(-1)?.[0]).toBe(url);
  });

  test("does not note platform requests", async () => {
    await requestInterceptor(new Request("https://platform.test/v1/probe"));
    expect(noteDaemonApiRequestMock).not.toHaveBeenCalled();
  });

  test("notes daemon routes issued through the platform client", async () => {
    // `subscribeEvents` opens the SSE stream through the platform client, so
    // the reopen in a resume burst is only counted if the platform chain
    // counts its daemon-bound paths.
    const url = `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/events/`;
    await requestInterceptor(new Request(url));
    expect(noteDaemonApiRequestMock).toHaveBeenCalledTimes(1);
    expect(noteDaemonApiRequestMock.mock.calls.at(-1)?.[0]).toBe(url);
  });

  test("notes a rewritten platform request exactly once", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const output = await requestInterceptor(
      new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`),
    );
    expect(new URL(output.url).origin).toBe(INGRESS);
    expect(noteDaemonApiRequestMock).toHaveBeenCalledTimes(1);
  });

  test("does not note platform-owned assistant routes", async () => {
    await requestInterceptor(
      new Request(
        `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/maintenance-mode/`,
      ),
    );
    expect(noteDaemonApiRequestMock).not.toHaveBeenCalled();
  });

  test("does not count when no resume window is open", async () => {
    resumeWindowOpen = false;
    await daemonRequestInterceptor(
      new Request("https://platform.test/v1/assistants/a1/conversations"),
    );
    await requestInterceptor(
      new Request(
        `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/events/`,
      ),
    );

    expect(noteDaemonApiRequestMock).not.toHaveBeenCalled();
  });

  test("does not count a platform request the features gate aborts", async () => {
    isLocalClientMock.mockImplementation(() => true);
    isPlatformDisabledMock.mockImplementation(() => true);
    // No ingress registered, so the daemon-bound path is not rewritten and the
    // gate downstream aborts it. An aborted request never reaches the network.
    const input = new Request(
      `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/conversations/`,
    );

    const output = await requestInterceptor(input);

    expect(platformFeaturesGate(output).signal.aborted).toBe(true);
    expect(noteDaemonApiRequestMock).not.toHaveBeenCalled();
  });

  test("does not count a platform request aborted in remote-gateway mode", async () => {
    window.__VELLUM_CONFIG__ = { mode: "remote-gateway" };
    const input = new Request(
      `${window.location.origin}/v1/assistants/${SELF_HOSTED_ID}/conversations/`,
    );

    const output = await requestInterceptor(input);

    expect(platformFeaturesGate(output).signal.aborted).toBe(true);
    expect(noteDaemonApiRequestMock).not.toHaveBeenCalled();
  });

  test("counts a gate-passing platform request exactly once", async () => {
    isLocalClientMock.mockImplementation(() => true);
    isPlatformDisabledMock.mockImplementation(() => true);
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const url = `https://platform.test${RUNTIME_PROXIED_PATH}`;

    const output = await requestInterceptor(new Request(url));

    expect(platformFeaturesGate(output).signal.aborted).toBe(false);
    expect(noteDaemonApiRequestMock).toHaveBeenCalledTimes(1);
    expect(noteDaemonApiRequestMock.mock.calls.at(-1)?.[0]).toBe(url);
  });

  test("a throwing counter leaves the request path intact", async () => {
    noteDaemonApiRequestImpl = () => {
      throw new Error("counter down");
    };
    const input = new Request(
      "https://platform.test/v1/assistants/a1/messages",
    );

    const output = await daemonRequestInterceptor(input);

    expect(output.url).toBe(input.url);
    expect(output.headers.get("X-Vellum-Client-Id")).toBe(getClientId());
  });
});
