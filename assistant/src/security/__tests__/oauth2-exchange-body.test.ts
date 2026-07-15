/**
 * Tests for `exchangeCodeForTokens` request shaping — specifically the two
 * Claude-required divergences from the OAuth2 defaults: a JSON-encoded body and
 * the `state` echoed back in that body. Anthropic's token endpoint rejects a
 * form-encoded, state-less exchange with HTTP 400, so these pin the wire shape
 * without hitting the network (global `fetch` is stubbed).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  exchangeCodeForTokens,
  type OAuth2Config,
} from "../oauth2.js";

const BASE_CONFIG: OAuth2Config = {
  authorizeUrl: "https://example.com/authorize",
  tokenExchangeUrl: "https://example.com/token",
  clientId: "client-abc",
  scopes: ["user:inference"],
  scopeSeparator: " ",
};

const CLAUDE_LIKE_CONFIG: OAuth2Config = {
  ...BASE_CONFIG,
  tokenExchangeBodyFormat: "json",
  sendStateInTokenExchange: true,
};

interface CapturedRequest {
  url: string;
  contentType?: string;
  rawBody: string;
}

let captured: CapturedRequest | undefined;
const realFetch = globalThis.fetch;

function stubFetchOk(): void {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body;
    captured = {
      url: String(url),
      contentType: headers["Content-Type"],
      rawBody:
        body instanceof URLSearchParams ? body.toString() : String(body ?? ""),
    };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "sk-ant-oat-xyz",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "user:inference",
      }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  captured = undefined;
  stubFetchOk();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("exchangeCodeForTokens — Claude JSON + state", () => {
  test("Claude-like config posts a JSON body that includes state", async () => {
    const result = await exchangeCodeForTokens(
      CLAUDE_LIKE_CONFIG,
      "auth-code",
      "http://localhost:1234/callback",
      "verifier-123",
      "state-xyz",
    );

    expect(result.tokens.accessToken).toBe("sk-ant-oat-xyz");
    expect(captured?.contentType).toBe("application/json");
    const body = JSON.parse(captured!.rawBody) as Record<string, string>;
    expect(body).toMatchObject({
      grant_type: "authorization_code",
      code: "auth-code",
      redirect_uri: "http://localhost:1234/callback",
      code_verifier: "verifier-123",
      state: "state-xyz",
      client_id: "client-abc",
    });
  });

  test("state is omitted from the body when the provider hasn't opted in", async () => {
    await exchangeCodeForTokens(
      BASE_CONFIG, // no sendStateInTokenExchange
      "auth-code",
      "http://localhost:1234/callback",
      "verifier-123",
      "state-xyz",
    );

    // Default form encoding, and no state leaks into a non-opted-in provider.
    expect(captured?.contentType).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(captured!.rawBody);
    expect(params.get("state")).toBeNull();
    expect(params.get("code")).toBe("auth-code");
  });

  test("opted-in provider still omits state when none is supplied", async () => {
    await exchangeCodeForTokens(
      CLAUDE_LIKE_CONFIG,
      "auth-code",
      "http://localhost:1234/callback",
      "verifier-123",
      // no state argument
    );

    const body = JSON.parse(captured!.rawBody) as Record<string, string>;
    expect(body.state).toBeUndefined();
  });
});
