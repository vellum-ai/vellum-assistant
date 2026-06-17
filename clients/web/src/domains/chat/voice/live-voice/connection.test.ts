/**
 * Tests for the live-voice WS connection + token-exchange client.
 *
 * Two surfaces under test:
 *   - `mintLiveVoiceToken` — must POST `/v1/auth/live-voice-token/` through
 *     the credentialed platform `client` (which attaches session cookie +
 *     CSRF + org header via the interceptor). We spy on `client.post` rather
 *     than `mock.module`-ing the whole SDK, matching the pattern in
 *     `domains/chat/inspector/compaction-trail-fetch.test.ts`.
 *   - `buildLiveVoiceWsUrl` — must produce the cloud velay URL with the
 *     `assistantId` in the path, a URL-encoded `?token=`, the `wss` scheme,
 *     and `conversationId` propagated only when supplied.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { client } from "@/generated/api/client.gen";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";

import {
  buildLiveVoiceWsUrl,
  buildSelfHostedLiveVoiceWsUrl,
  getVelayWsScheme,
  LiveVoiceTokenError,
  mintLiveVoiceToken,
  resolveLiveVoiceWsUrl,
} from "./connection";

// ---------------------------------------------------------------------------
// mintLiveVoiceToken
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
});

describe("mintLiveVoiceToken", () => {
  test("POSTs the documented mint endpoint with the assistantId body", async () => {
    await mintLiveVoiceToken("assistant-1");

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("/v1/auth/live-voice-token/");
    expect(captured!.body).toEqual({ assistantId: "assistant-1" });
  });

  test("returns { token, expiresAt } from the response", async () => {
    const result = await mintLiveVoiceToken("assistant-1");
    expect(result).toEqual({
      token: "tok-abc",
      expiresAt: "2026-06-01T00:05:00Z",
    });
  });

  test("throws LiveVoiceTokenError with the HTTP status on non-OK", async () => {
    nextPostResult = {
      data: null,
      error: { detail: "forbidden" },
      response: new Response(null, { status: 403 }),
    };

    try {
      await mintLiveVoiceToken("assistant-1");
      throw new Error("expected mintLiveVoiceToken to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LiveVoiceTokenError);
      expect((err as LiveVoiceTokenError).status).toBe(403);
    }
  });

  test("throws LiveVoiceTokenError(0) when the body is malformed", async () => {
    nextPostResult = {
      data: { token: "tok-abc" }, // missing expiresAt
      error: null,
      response: new Response(null, { status: 200 }),
    };

    try {
      await mintLiveVoiceToken("assistant-1");
      throw new Error("expected mintLiveVoiceToken to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LiveVoiceTokenError);
      expect((err as LiveVoiceTokenError).status).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// buildLiveVoiceWsUrl
// ---------------------------------------------------------------------------

describe("buildLiveVoiceWsUrl", () => {
  test("builds the cloud velay URL with assistantId path + wss scheme + ?token=", () => {
    const url = new URL(
      buildLiveVoiceWsUrl({ assistantId: "assistant-1", token: "tok-abc" }),
    );
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("velay.vellum.ai");
    expect(url.pathname).toBe("/assistant-1/v1/live-voice");
    expect(url.searchParams.get("token")).toBe("tok-abc");
    expect(url.searchParams.has("conversationId")).toBe(false);
  });

  test("URL-encodes tokens containing reserved characters", () => {
    const token = "a/b+c=d e";
    const raw = buildLiveVoiceWsUrl({ assistantId: "assistant-1", token });
    // The encoded form must round-trip back to the original token.
    expect(new URL(raw).searchParams.get("token")).toBe(token);
    // And the raw string must not carry the unencoded reserved chars.
    expect(raw).not.toContain("token=a/b+c=d e");
  });

  test("appends conversationId as an additional query param when provided", () => {
    const url = new URL(
      buildLiveVoiceWsUrl({
        assistantId: "assistant-1",
        conversationId: "conv-xyz",
        token: "tok-abc",
      }),
    );
    expect(url.searchParams.get("token")).toBe("tok-abc");
    expect(url.searchParams.get("conversationId")).toBe("conv-xyz");
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
// buildSelfHostedLiveVoiceWsUrl
// ---------------------------------------------------------------------------

describe("buildSelfHostedLiveVoiceWsUrl", () => {
  test("maps an https ingress to wss, no assistantId path prefix, actor token", () => {
    const url = new URL(
      buildSelfHostedLiveVoiceWsUrl({
        ingressUrl: "https://x.ngrok-free.app",
        token: "actor-tok",
      }),
    );
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("x.ngrok-free.app");
    // Gateway serves /v1/live-voice directly — no /<assistantId> prefix.
    expect(url.pathname).toBe("/v1/live-voice");
    expect(url.searchParams.get("token")).toBe("actor-tok");
    expect(url.searchParams.has("conversationId")).toBe(false);
  });

  test("maps a plain-http local ingress to ws", () => {
    const url = new URL(
      buildSelfHostedLiveVoiceWsUrl({
        ingressUrl: "http://localhost:8787",
        token: "actor-tok",
      }),
    );
    expect(url.protocol).toBe("ws:");
    expect(url.host).toBe("localhost:8787");
    expect(url.pathname).toBe("/v1/live-voice");
  });

  test("preserves the ingress path prefix (local Docker proxy) and drops query/hash", () => {
    // Local mode reaches the gateway at a path-based proxy under the SPA origin.
    const url = new URL(
      buildSelfHostedLiveVoiceWsUrl({
        ingressUrl: "http://localhost:3000/assistant/__gateway/7821?a=1#frag",
        conversationId: "conv-xyz",
        token: "actor-tok",
      }),
    );
    expect(url.protocol).toBe("ws:");
    expect(url.host).toBe("localhost:3000");
    // Prefix preserved, /v1/live-voice appended — matches the HTTP interceptor.
    expect(url.pathname).toBe("/assistant/__gateway/7821/v1/live-voice");
    expect(url.hash).toBe("");
    expect(url.searchParams.get("a")).toBeNull();
    expect(url.searchParams.get("token")).toBe("actor-tok");
    expect(url.searchParams.get("conversationId")).toBe("conv-xyz");
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
    ).rejects.toBeInstanceOf(LiveVoiceTokenError);
    expect(captured).toBeNull();
  });
});
