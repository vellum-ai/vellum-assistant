/**
 * Tests for the `browser-relay-require-guardian` assistant feature flag.
 *
 * The flag gates the fail-closed behavior introduced in PR1 of the
 * browser-use remediation plan. Until PR3 cuts the self-hosted gateway
 * over to guardian-bound capability tokens, the legacy
 * `svc:browser-relay:self` token path still needs to upgrade successfully.
 *
 * Verifies:
 *   1. The flag is declared in the registry and defaults to DISABLED.
 *   2. With the flag DISABLED, a service-token upgrade with no guardian
 *      context still completes successfully (legacy pass-through).
 *   3. With the flag ENABLED, a service-token upgrade with no guardian
 *      context is rejected with 401 before the WebSocket can open.
 *   4. An actor-bound token always upgrades successfully, regardless of
 *      the flag state.
 *   5. A service-token upgrade that carries an explicit `x-guardian-id`
 *      header always upgrades successfully, regardless of the flag state.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ── Module mocks (must be declared before the real imports below) ────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target, prop: string) => {
        if (prop === "child")
          return () =>
            new Proxy({} as Record<string, unknown>, {
              get: () => () => {},
            });
        return () => {};
      },
    }),
}));

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
    ingress: {
      publicBaseUrl: "https://test.example.com",
    },
  }),
  getConfig: () => ({
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
    ingress: {
      publicBaseUrl: "https://test.example.com",
    },
  }),
  invalidateConfigCache: () => {},
}));

mock.module("../security/secure-keys.js", () => ({}));

mock.module("../security/oauth-callback-registry.js", () => ({
  consumeCallback: () => true,
  consumeCallbackError: () => true,
}));

mock.module("../calls/call-store.js", () => ({
  getCallSession: () => null,
  getCallSessionByCallSid: () => null,
  updateCallSession: () => {},
  recordCallEvent: () => {},
  expirePendingQuestions: () => {},
}));

// ── Real imports (after mocks) ──────────────────────────────────────

import {
  _setOverridesForTesting,
  isAssistantFeatureFlagEnabled,
} from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";
import { mintToken } from "../runtime/auth/token-service.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const FLAG_KEY = "browser-relay-require-guardian";
const TEST_ACTOR_PRINCIPAL = "test-guardian-principal-id";
const WS_OPEN = 1;
const UPGRADE_TIMEOUT_MS = 1500;

/**
 * Mint an actor-bound token (sub=actor:self:<actor>) that the browser-relay
 * upgrade handler treats as the loopback/desktop path. `actorPrincipalId` is
 * used as the guardianId and no fallback is needed.
 */
function mintActorToken(
  actorPrincipalId: string = TEST_ACTOR_PRINCIPAL,
): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: `actor:self:${actorPrincipalId}`,
    scope_profile: "actor_client_v1",
    policy_epoch: 1,
    ttlSeconds: 3600,
  });
}

/**
 * Mint a service-style token that matches the shape of the legacy
 * browser-relay service token: the sub parses as a gateway-type principal
 * with no `actorPrincipalId`, so the upgrade handler falls into the
 * "service-token path" branch that the flag gates.
 *
 * Note: the real self-hosted `/v1/browser-relay/token` endpoint mints
 * `sub=svc:browser-relay:self`, but that pattern does not currently parse
 * via `parseSub`. `svc:gateway:self` is a well-formed service-token sub
 * that exercises the same code path (no actor principal => service-token
 * branch) and is what the gateway uses when proxying the upgrade today.
 */
function mintServiceToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_ingress_v1",
    policy_epoch: 1,
    ttlSeconds: 3600,
  });
}

/**
 * Outcome of a browser-relay upgrade attempt. Either the WebSocket reached
 * the OPEN state (upgrade accepted) or it closed before opening (upgrade
 * rejected). `closeCode` is set when the socket closed without opening —
 * for HTTP rejections, Bun surfaces the 4xx status via a close event.
 */
interface UpgradeOutcome {
  opened: boolean;
  closeCode?: number;
  closeReason?: string;
}

/**
 * Drive a single /v1/browser-relay upgrade attempt and return whether it
 * reached the OPEN state. Times out after `UPGRADE_TIMEOUT_MS` so the
 * test never hangs.
 */
async function tryBrowserRelayUpgrade(
  port: number,
  token: string,
  extraHeaders?: Record<string, string>,
  extraQuery?: Record<string, string>,
): Promise<UpgradeOutcome> {
  const queryParts = [`token=${encodeURIComponent(token)}`];
  if (extraQuery) {
    for (const [k, v] of Object.entries(extraQuery)) {
      queryParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  const wsUrl = `ws://127.0.0.1:${port}/v1/browser-relay?${queryParts.join("&")}`;

  // Bun's WebSocket constructor accepts an options object with a
  // `headers` field as a Bun-specific extension of the DOM API.
  const wsOptions: { headers?: Record<string, string> } = {};
  if (extraHeaders) wsOptions.headers = extraHeaders;
  const socket = new WebSocket(
    wsUrl,
    wsOptions as unknown as string | string[],
  );

  return await new Promise<UpgradeOutcome>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // ignore
      }
      // Inspect the readyState to decide the verdict on timeout.
      if (socket.readyState === WS_OPEN) {
        resolve({ opened: true });
      } else {
        resolve({ opened: false });
      }
    }, UPGRADE_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Close immediately so the server-side handlers tear down and we
      // don't leak a connection between tests.
      try {
        socket.close(1000, "test complete");
      } catch {
        // ignore
      }
      resolve({ opened: true });
    });

    socket.addEventListener("close", (ev: CloseEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        opened: false,
        closeCode: ev.code,
        closeReason: ev.reason,
      });
    });

    socket.addEventListener("error", () => {
      if (settled) return;
      // Wait for the close event to fire — it carries the status code.
    });
  });
}

function makeConfig(): AssistantConfig {
  return {} as AssistantConfig;
}

// ---------------------------------------------------------------------------
// Unit tests: flag default + override behavior
// ---------------------------------------------------------------------------

describe("browser-relay-require-guardian feature flag", () => {
  afterEach(() => {
    _setOverridesForTesting({});
  });

  test("defaults to disabled", () => {
    const config = makeConfig();
    expect(isAssistantFeatureFlagEnabled(FLAG_KEY, config)).toBe(false);
  });

  test("can be enabled via overrides", () => {
    _setOverridesForTesting({ [FLAG_KEY]: true });
    const config = makeConfig();
    expect(isAssistantFeatureFlagEnabled(FLAG_KEY, config)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: fail-closed branch is gated by the flag
// ---------------------------------------------------------------------------

describe("browser-relay upgrade: fail-closed gating", () => {
  let server: RuntimeHttpServer;
  let port: number;

  beforeAll(async () => {
    server = new RuntimeHttpServer({
      port: 0,
      hostname: "127.0.0.1",
      bearerToken: "test-bearer-token",
    });
    await server.start();
    port = server.actualPort;
  });

  afterAll(async () => {
    await server.stop();
  });

  afterEach(() => {
    _setOverridesForTesting({});
  });

  // ── Flag DISABLED (default) — legacy pass-through ────────────────────

  test("flag disabled (default): service-token upgrade without guardian is allowed", async () => {
    // Ensure the flag really is disabled for this process.
    _setOverridesForTesting({ [FLAG_KEY]: false });

    const outcome = await tryBrowserRelayUpgrade(port, mintServiceToken());
    expect(outcome.opened).toBe(true);
  });

  test("flag disabled (default): missing token is still rejected", async () => {
    _setOverridesForTesting({ [FLAG_KEY]: false });

    // Omit the `?token=` query parameter entirely. The flag gate must
    // only affect the "no guardian context" branch — missing tokens
    // should still fail auth.
    const res = await fetch(`http://127.0.0.1:${port}/v1/browser-relay`, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    });
    expect(res.status).toBe(401);
    await res.text().catch(() => undefined);
  });

  // ── Flag ENABLED — new fail-closed behavior kicks in ─────────────────

  test("flag enabled: service-token upgrade without guardian is rejected", async () => {
    _setOverridesForTesting({ [FLAG_KEY]: true });

    const outcome = await tryBrowserRelayUpgrade(port, mintServiceToken());
    expect(outcome.opened).toBe(false);

    // Belt-and-braces: confirm the HTTP fallback also returns 401 so the
    // rejection message is visible in the response body. Fetch won't
    // hang here because the handler short-circuits before upgrade.
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/browser-relay?token=${encodeURIComponent(mintServiceToken())}`,
      {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
        },
      },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toContain("guardian context");
  });

  test("flag enabled: service-token upgrade with x-guardian-id header is allowed", async () => {
    _setOverridesForTesting({ [FLAG_KEY]: true });

    const outcome = await tryBrowserRelayUpgrade(port, mintServiceToken(), {
      "x-guardian-id": "explicit-guardian-from-header",
    });
    expect(outcome.opened).toBe(true);
  });

  test("flag enabled: service-token upgrade with guardianId query param is allowed", async () => {
    _setOverridesForTesting({ [FLAG_KEY]: true });

    const outcome = await tryBrowserRelayUpgrade(
      port,
      mintServiceToken(),
      undefined,
      { guardianId: "explicit-guardian-from-query" },
    );
    expect(outcome.opened).toBe(true);
  });

  // ── Actor-bound tokens always pass, regardless of flag state ─────────

  test("flag enabled: actor-bound token upgrade bypasses the gate", async () => {
    _setOverridesForTesting({ [FLAG_KEY]: true });

    const outcome = await tryBrowserRelayUpgrade(port, mintActorToken());
    expect(outcome.opened).toBe(true);
  });

  test("flag disabled: actor-bound token upgrade still works", async () => {
    _setOverridesForTesting({ [FLAG_KEY]: false });

    const outcome = await tryBrowserRelayUpgrade(port, mintActorToken());
    expect(outcome.opened).toBe(true);
  });
});
