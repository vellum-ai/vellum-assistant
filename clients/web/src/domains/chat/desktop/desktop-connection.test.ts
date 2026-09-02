/**
 * The desktop stream's transport rules: which URL each deployment kind dials,
 * which one gets refused, and what a close code means once the socket is gone.
 *
 * Nothing is `mock.module`-ed: bun shares one process across test files, so a
 * stand-in for the connection module would outlive this file. The managed
 * path's mint is intercepted at the platform client's `post`, the way
 * `live-voice/connection.test.ts` does it, so every URL asserted on below is
 * the one the app would dial.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  PairedVoiceUnavailableError,
  VelayWsTokenError,
} from "@/domains/chat/voice/live-voice/connection";
import { client } from "@/generated/api/client.gen";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";

import {
  buildDesktopStreamWsUrl,
  desktopEndReasonForClose,
  desktopEndReasonForResolveError,
  resolveDesktopStreamWsUrl,
} from "./desktop-connection";

/** Bodies the mint endpoint was posted, in order. */
let mintCalls: Array<Record<string, unknown> | undefined> = [];
const originalPost = client.post;

beforeEach(() => {
  mintCalls = [];
  client.post = mock(async (options: { body?: Record<string, unknown> }) => {
    mintCalls.push(options.body);
    return {
      data: { token: "velay-token", expiresAt: "2099-01-01T00:00:00Z" },
      error: null,
      response: new Response(null, { status: 200 }),
    };
  }) as typeof client.post;
  setSelfHostedConnection(null);
});

afterEach(() => {
  client.post = originalPost;
  setSelfHostedConnection(null);
});

describe("the desktop stream URL", () => {
  test("dials the gateway ingress with the actor token", () => {
    const url = new URL(
      buildDesktopStreamWsUrl({
        ingressUrl: "https://gateway.example.com",
        token: "actor-jwt",
      }),
    );
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/v1/desktop/stream");
    expect(url.searchParams.get("token")).toBe("actor-jwt");
  });

  test("bypasses the local HTTP-only proxy for a direct loopback dial", () => {
    const url = new URL(
      buildDesktopStreamWsUrl({
        ingressUrl: "http://localhost:3000/assistant/__gateway/8500",
        token: "actor-jwt",
      }),
    );
    expect(url.origin).toBe("ws://127.0.0.1:8500");
    expect(url.pathname).toBe("/v1/desktop/stream");
  });
});

describe("resolving the desktop stream URL", () => {
  test("self-hosted: dials the ingress directly and mints nothing", async () => {
    setSelfHostedConnection({
      url: "http://localhost:8500",
      token: "actor-jwt",
    });

    const url = new URL(await resolveDesktopStreamWsUrl("asst-1"));

    expect(url.protocol).toBe("ws:");
    expect(url.host).toBe("localhost:8500");
    expect(url.pathname).toBe("/v1/desktop/stream");
    expect(url.searchParams.get("token")).toBe("actor-jwt");
    expect(mintCalls).toEqual([]);
  });

  test("self-hosted: refuses before the actor token is provisioned", async () => {
    setSelfHostedConnection({ url: "http://localhost:8500", token: null });

    await expect(resolveDesktopStreamWsUrl("asst-1")).rejects.toBeInstanceOf(
      VelayWsTokenError,
    );
  });

  test("paired: refuses outright rather than dialling an HTTP-only proxy", async () => {
    setSelfHostedConnection({
      url: "http://localhost:3000/assistant/__gateway-paired/asst-1",
      token: "actor-jwt",
    });

    await expect(resolveDesktopStreamWsUrl("asst-1")).rejects.toBeInstanceOf(
      PairedVoiceUnavailableError,
    );
    expect(mintCalls).toEqual([]);
  });

  test("managed: mints a velay token and dials velay with it", async () => {
    const url = new URL(await resolveDesktopStreamWsUrl("asst-1"));

    expect(mintCalls).toEqual([{ assistantId: "asst-1" }]);
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("velay.vellum.ai");
    // The `/<assistantId>` prefix selects the tunnel; velay strips it to
    // recover the upstream path it matches its allowlist against.
    expect(url.pathname).toBe("/asst-1/v1/desktop/stream");
    expect(url.searchParams.get("token")).toBe("velay-token");
  });
});

describe("what a close code means", () => {
  test("1013 is another viewer holding the slot", () => {
    expect(desktopEndReasonForClose(1013)).toBe("busy");
  });

  test("1008 is an assistant with no desktop to serve", () => {
    expect(desktopEndReasonForClose(1008)).toBe("unavailable");
  });

  test("1011 is a desktop that did not start", () => {
    expect(desktopEndReasonForClose(1011)).toBe("failed");
  });

  test("anything else is a connection worth retrying", () => {
    expect(desktopEndReasonForClose(1000)).toBe("lost");
    expect(desktopEndReasonForClose(1006)).toBe("lost");
  });

  test("a paired refusal reads as unavailable, other resolve errors as failed", () => {
    expect(
      desktopEndReasonForResolveError(new PairedVoiceUnavailableError()),
    ).toBe("unavailable");
    expect(
      desktopEndReasonForResolveError(new VelayWsTokenError(403, "refused")),
    ).toBe("failed");
  });
});
