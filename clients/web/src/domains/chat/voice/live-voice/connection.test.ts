/**
 * Tests for the live-voice WS connection + token-exchange client.
 *
 * Two surfaces under test:
 *   - `mintVelayWsToken` — must POST `/v1/auth/live-voice-token/` through
 *     the credentialed platform `client` (which attaches session cookie +
 *     CSRF + org header via the interceptor). We spy on `client.post` rather
 *     than `mock.module`-ing the whole SDK, matching the pattern in
 *     `domains/chat/inspector/compaction-trail-fetch.test.ts`.
 *   - `buildVelayWsUrl` / `buildSelfHostedGatewayWsUrl` and the resolvers on
 *     top of them: the cloud velay URL carries the `assistantId` in the path,
 *     a URL-encoded `?token=`, and the `wss` scheme; the self-hosted URL
 *     follows the ingress and bypasses the HTTP-only local proxy.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { client } from "@/generated/api/client.gen";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";

import {
  buildSelfHostedGatewayWsUrl,
  buildVelayWsUrl,
  getVelayWsScheme,
  isPairedGatewayIngress,
  VelayWsTokenError,
  mintVelayWsToken,
  PairedVoiceUnavailableError,
  resolveGatewayWsUrl,
  resolveLiveVoiceWsUrl,
} from "./connection";

// ---------------------------------------------------------------------------
// mintVelayWsToken
// ---------------------------------------------------------------------------

type CapturedPostOptions = {
  url: string;
  body?: Record<string, unknown>;
};

let captured: CapturedPostOptions | null = null;
let nextPostResult: { data: unknown; error: unknown; response: Response };
const originalPost = client.post;

beforeEach(() => {
  captured = null;
  nextPostResult = {
    data: { token: "tok-abc", expiresAt: "2026-06-01T00:05:00Z" },
    error: null,
    response: new Response(null, { status: 200 }),
  };
  client.post = mock(async (options: CapturedPostOptions) => {
    captured = options;
    return nextPostResult;
  }) as typeof client.post;
  // Default to the cloud path; self-hosted tests prime this explicitly.
  setSelfHostedConnection(null);
});

afterEach(() => {
  client.post = originalPost;
  setSelfHostedConnection(null);
  window.__VELLUM_CONFIG__ = undefined;
});

describe("mintVelayWsToken", () => {
  test("POSTs the documented mint endpoint with the assistantId body", async () => {
    await mintVelayWsToken("assistant-1");

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("/v1/auth/live-voice-token/");
    expect(captured!.body).toEqual({ assistantId: "assistant-1" });
  });

  test("returns { token, expiresAt } from the response", async () => {
    const result = await mintVelayWsToken("assistant-1");
    expect(result).toEqual({
      token: "tok-abc",
      expiresAt: "2026-06-01T00:05:00Z",
    });
  });

  test("throws VelayWsTokenError with the HTTP status on non-OK", async () => {
    nextPostResult = {
      data: null,
      error: { detail: "forbidden" },
      response: new Response(null, { status: 403 }),
    };

    try {
      await mintVelayWsToken("assistant-1");
      throw new Error("expected mintVelayWsToken to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(VelayWsTokenError);
      expect((err as VelayWsTokenError).status).toBe(403);
    }
  });

  test("throws VelayWsTokenError(0) when the body is malformed", async () => {
    nextPostResult = {
      data: { token: "tok-abc" }, // missing expiresAt
      error: null,
      response: new Response(null, { status: 200 }),
    };

    try {
      await mintVelayWsToken("assistant-1");
      throw new Error("expected mintVelayWsToken to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(VelayWsTokenError);
      expect((err as VelayWsTokenError).status).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// buildVelayWsUrl
// ---------------------------------------------------------------------------

describe("buildVelayWsUrl", () => {
  const args = { assistantId: "assistant-1", routePath: "/v1/live-voice" };

  test("URL-encodes tokens containing reserved characters", () => {
    const token = "a/b+c=d e";
    const raw = buildVelayWsUrl({ ...args, token });
    // The encoded form must round-trip back to the original token.
    expect(new URL(raw).searchParams.get("token")).toBe(token);
    // And the raw string must not carry the unencoded reserved chars.
    expect(raw).not.toContain("token=a/b+c=d e");
  });

  test("derives the velay host from the injected platform URL (Electron shell)", () => {
    window.__VELLUM_CONFIG__ = {
      platformUrl: "https://staging-platform.vellum.ai",
    };
    const url = new URL(buildVelayWsUrl({ ...args, token: "tok-abc" }));
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("velay-staging.vellum.ai");
  });

  test("falls back to the prod velay host for an off-convention platform URL", () => {
    window.__VELLUM_CONFIG__ = { platformUrl: "http://localhost:8000" };
    const url = new URL(buildVelayWsUrl({ ...args, token: "tok-abc" }));
    expect(url.host).toBe("velay.vellum.ai");
  });
});

// ---------------------------------------------------------------------------
// getVelayWsScheme — TLS for prod, plain ws for the local loopback velay
// ---------------------------------------------------------------------------

describe("getVelayWsScheme", () => {
  test("uses wss for the production velay host", () => {
    expect(getVelayWsScheme("velay.vellum.ai")).toBe("wss");
  });

  test("uses ws for loopback hosts (local vel up velay)", () => {
    expect(getVelayWsScheme("localhost:8501")).toBe("ws");
    expect(getVelayWsScheme("127.0.0.1:8501")).toBe("ws");
    expect(getVelayWsScheme("[::1]:8501")).toBe("ws");
  });

  test("uses wss for a non-loopback host without a scheme", () => {
    expect(getVelayWsScheme("velay.staging.vellum.ai")).toBe("wss");
  });
});

// ---------------------------------------------------------------------------
// buildSelfHostedGatewayWsUrl
// ---------------------------------------------------------------------------

describe("buildSelfHostedGatewayWsUrl", () => {
  const args = { routePath: "/v1/live-voice", token: "actor-tok" };

  test("local __gateway proxy path: dials the loopback gateway port directly", () => {
    // The HTTP-only __gateway proxy can't carry a WS upgrade, so the socket
    // bypasses it and hits 127.0.0.1:<port>. Origin host, prefix, query, and
    // hash are all dropped; the bypass keys off the path, not the scheme.
    const url = new URL(
      buildSelfHostedGatewayWsUrl({
        ...args,
        ingressUrl: "https://app.example/assistant/__gateway/7821?a=1#frag",
        params: { conversationId: "conv-xyz" },
      }),
    );
    expect(url.protocol).toBe("ws:");
    expect(url.host).toBe("127.0.0.1:7821");
    expect(url.pathname).toBe("/v1/live-voice");
    expect(url.hash).toBe("");
    expect(url.searchParams.get("a")).toBeNull();
    expect(url.searchParams.get("token")).toBe("actor-tok");
    expect(url.searchParams.get("conversationId")).toBe("conv-xyz");
  });

  test("paired __gateway-paired path throws PairedVoiceUnavailableError on any origin", () => {
    // The paired proxy is HTTP-only with no loopback port to bypass to, so the
    // builder fails typed before any dial. On an Electron app:// origin a raw
    // dial would otherwise throw an opaque WebSocket construction error.
    for (const ingressUrl of [
      "http://localhost:3000/assistant/__gateway-paired/asst-1",
      "app://vellum/assistant/__gateway-paired/asst-1",
    ]) {
      expect(() =>
        buildSelfHostedGatewayWsUrl({ ...args, ingressUrl }),
      ).toThrow(PairedVoiceUnavailableError);
    }
  });

  test("remote ingress keeps its host and path prefix, drops query and hash", () => {
    const url = new URL(
      buildSelfHostedGatewayWsUrl({
        ...args,
        ingressUrl: "https://x.ngrok-free.app/gw?a=1#frag",
      }),
    );
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("x.ngrok-free.app");
    expect(url.pathname).toBe("/gw/v1/live-voice");
    expect(url.hash).toBe("");
    expect(url.searchParams.get("a")).toBeNull();
    expect(url.searchParams.get("token")).toBe("actor-tok");
  });
});

// ---------------------------------------------------------------------------
// resolveGatewayWsUrl: the routing every gateway WS shares
// ---------------------------------------------------------------------------

describe("resolveGatewayWsUrl", () => {
  const args = {
    assistantId: "asst-1",
    routePath: "/v1/desktop/stream",
    label: "desktop",
  };

  test("self-hosted: dials the ingress directly and mints nothing", async () => {
    setSelfHostedConnection({
      url: "http://localhost:8500",
      token: "actor-jwt",
    });

    const url = new URL(await resolveGatewayWsUrl(args));

    expect(url.origin).toBe("ws://localhost:8500");
    expect(url.pathname).toBe("/v1/desktop/stream");
    expect(url.searchParams.get("token")).toBe("actor-jwt");
    expect(captured).toBeNull();
  });

  test("self-hosted: refuses before the actor token is provisioned, naming the stream", async () => {
    setSelfHostedConnection({ url: "http://localhost:8500", token: null });

    await expect(resolveGatewayWsUrl(args)).rejects.toThrow(
      /Self-hosted desktop has no actor token yet/,
    );
    expect(captured).toBeNull();
  });

  test("paired: refuses outright rather than dialling an HTTP-only proxy", async () => {
    setSelfHostedConnection({
      url: "http://localhost:3000/assistant/__gateway-paired/asst-1",
      token: "actor-jwt",
    });

    await expect(resolveGatewayWsUrl(args)).rejects.toBeInstanceOf(
      PairedVoiceUnavailableError,
    );
    expect(captured).toBeNull();
  });

  test("managed: mints a velay token and dials velay with it, params included", async () => {
    const url = new URL(
      await resolveGatewayWsUrl({ ...args, params: { sampleRate: "16000" } }),
    );

    expect(captured?.body).toEqual({ assistantId: "asst-1" });
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("velay.vellum.ai");
    // The `/<assistantId>` prefix selects the tunnel; velay strips it to
    // recover the upstream path it matches its allowlist against.
    expect(url.pathname).toBe("/asst-1/v1/desktop/stream");
    expect(url.searchParams.get("token")).toBe("tok-abc");
    expect(url.searchParams.get("sampleRate")).toBe("16000");
  });
});

// ---------------------------------------------------------------------------
// resolveLiveVoiceWsUrl — transport routing (cloud vs self-hosted)
// ---------------------------------------------------------------------------

describe("resolveLiveVoiceWsUrl", () => {
  test("cloud path: mints a velay token and builds the velay URL", async () => {
    // GIVEN no self-hosted ingress (default)
    const raw = await resolveLiveVoiceWsUrl({
      assistantId: "assistant-1",
      conversationId: "conv-xyz",
    });

    // THEN it mints and dials velay with the assistantId path prefix
    expect(captured?.url).toBe("/v1/auth/live-voice-token/");
    const url = new URL(raw);
    expect(url.host).toBe("velay.vellum.ai");
    expect(url.pathname).toBe("/assistant-1/v1/live-voice");
    expect(url.searchParams.get("token")).toBe("tok-abc");
    expect(url.searchParams.get("conversationId")).toBe("conv-xyz");
  });

  /**
   * A session with no conversation named starts one rather than joining a
   * thread, so the parameter has to be absent, not present and empty.
   */
  test("cloud path: omits conversationId when none is given", async () => {
    const raw = await resolveLiveVoiceWsUrl({ assistantId: "assistant-1" });

    expect(new URL(raw).searchParams.has("conversationId")).toBe(false);
  });

  test("self-hosted path: dials the gateway with the actor token, no mint", async () => {
    // GIVEN a primed self-hosted connection
    setSelfHostedConnection({
      url: "https://x.ngrok-free.app",
      token: "actor-tok",
    });

    const raw = await resolveLiveVoiceWsUrl({
      assistantId: "assistant-1",
      conversationId: "conv-xyz",
    });

    // THEN no velay token is minted...
    expect(captured).toBeNull();
    // ...and the URL targets the gateway with the actor token
    const url = new URL(raw);
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("x.ngrok-free.app");
    expect(url.pathname).toBe("/v1/live-voice");
    expect(url.searchParams.get("token")).toBe("actor-tok");
    expect(url.searchParams.get("conversationId")).toBe("conv-xyz");
  });

  test("self-hosted with no actor token yet throws (and does not mint)", async () => {
    // GIVEN an ingress is known but the actor token hasn't been provisioned
    setSelfHostedConnection({ url: "https://x.ngrok-free.app", token: null });

    await expect(
      resolveLiveVoiceWsUrl({ assistantId: "assistant-1" }),
    ).rejects.toBeInstanceOf(VelayWsTokenError);
    expect(captured).toBeNull();
  });

  test("paired ingress rejects with the voice-unavailable reason (and does not mint)", async () => {
    // GIVEN the active selection is a paired assistant riding the HTTP-only
    // same-origin proxy
    setSelfHostedConnection({
      url: "http://localhost:3000/assistant/__gateway-paired/asst-1",
      token: "actor-tok",
    });

    // THEN the resolve fails typed with the user-facing reason live-voice
    // surfaces via Error.message, and no velay token is minted
    await expect(
      resolveLiveVoiceWsUrl({ assistantId: "assistant-1" }),
    ).rejects.toThrow("Voice isn't available for paired assistants yet.");
    expect(captured).toBeNull();
  });

  test("paired ingress rejects even before the actor token is provisioned", async () => {
    setSelfHostedConnection({
      url: "app://vellum/assistant/__gateway-paired/asst-1",
      token: null,
    });

    await expect(
      resolveLiveVoiceWsUrl({ assistantId: "assistant-1" }),
    ).rejects.toBeInstanceOf(PairedVoiceUnavailableError);
    expect(captured).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isPairedGatewayIngress
// ---------------------------------------------------------------------------

describe("isPairedGatewayIngress", () => {
  test("matches the paired proxy path on browser and Electron origins", () => {
    expect(
      isPairedGatewayIngress(
        "http://localhost:3000/assistant/__gateway-paired/asst-1",
      ),
    ).toBe(true);
    expect(
      isPairedGatewayIngress("app://vellum/assistant/__gateway-paired/asst-1"),
    ).toBe(true);
  });

  test("does not match local proxy paths, remote ingresses, or junk", () => {
    expect(
      isPairedGatewayIngress("http://localhost:3000/assistant/__gateway/7821"),
    ).toBe(false);
    expect(isPairedGatewayIngress("https://x.ngrok-free.app")).toBe(false);
    expect(isPairedGatewayIngress("not a url")).toBe(false);
  });
});
