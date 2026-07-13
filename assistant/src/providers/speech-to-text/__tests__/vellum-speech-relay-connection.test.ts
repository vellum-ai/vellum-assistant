import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let mockMintResult: string | null = "minted-token";

mock.module("../../../runtime/auth/token-service.js", () => ({
  mintToken: (params: { aud: string; sub: string }) => {
    if (mockMintResult === null) {
      throw new Error("signing key unavailable");
    }
    return `${mockMintResult}:${params.aud}:${params.sub}`;
  },
}));

import {
  mapVelayError,
  probeVelayRejection,
  resolveSpeechRelayConnection,
} from "../vellum-speech-relay-connection.js";

describe("resolveSpeechRelayConnection", () => {
  const originalEnv = process.env.GATEWAY_INTERNAL_URL;

  beforeEach(() => {
    mockMintResult = "minted-token";
    delete process.env.GATEWAY_INTERNAL_URL;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GATEWAY_INTERNAL_URL;
    } else {
      process.env.GATEWAY_INTERNAL_URL = originalEnv;
    }
  });

  test("resolves the gateway origin and a per-dial token minter", async () => {
    process.env.GATEWAY_INTERNAL_URL = "http://gateway:7822/";

    const connection = await resolveSpeechRelayConnection();
    expect(connection).not.toBeNull();
    expect(connection!.httpBaseUrl).toBe("http://gateway:7822");
    expect(connection!.wsBaseUrl).toBe("ws://gateway:7822");
    // The token targets the gateway audience with the daemon service sub.
    expect(connection!.mintServiceToken()).toBe(
      "minted-token:vellum-gateway:svc:daemon:self",
    );
  });

  test("returns null when the signing key is unavailable", async () => {
    mockMintResult = null;
    expect(await resolveSpeechRelayConnection()).toBeNull();
  });
});

describe("mapVelayError", () => {
  test("maps the relay contract's codes onto categories", () => {
    expect(mapVelayError({ code: "invalid_key" }).category).toBe("auth");
    expect(
      mapVelayError({ code: "missing_platform_connection" }),
    ).toMatchObject({
      category: "auth",
      message: expect.stringContaining("platform connect"),
    });
    expect(mapVelayError({ code: "invalid_token" })).toMatchObject({
      category: "auth",
      message: expect.stringContaining("service token"),
    });
    expect(mapVelayError({ code: "insufficient_balance" })).toMatchObject({
      category: "provider-error",
      message: expect.stringContaining("credits"),
    });
    expect(mapVelayError({ code: "provider_unreachable" }).category).toBe(
      "provider-error",
    );
    expect(mapVelayError({ code: "upstream_error" }).category).toBe(
      "provider-error",
    );
    expect(mapVelayError({ code: "novel_code", detail: "what" })).toMatchObject(
      {
        category: "provider-error",
        message: expect.stringContaining("novel_code"),
      },
    );
  });
});

describe("probeVelayRejection", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns the JSON rejection body", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: "invalid_key", detail: "nope" }), {
        status: 401,
      })) as unknown as typeof fetch;

    expect(await probeVelayRejection("http://gateway.test/x")).toEqual({
      code: "invalid_key",
      detail: "nope",
    });
  });

  test("returns null on the gateway's gate-passed 426", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ code: "upgrade_required", detail: "connect via WS" }),
        { status: 426 },
      )) as unknown as typeof fetch;

    expect(await probeVelayRejection("http://gateway.test/x")).toBeNull();
  });

  test("returns null when the probe itself fails", async () => {
    globalThis.fetch = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;

    expect(await probeVelayRejection("http://gateway.test/x")).toBeNull();
  });
});
