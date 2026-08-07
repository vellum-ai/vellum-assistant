/**
 * Tests for the shared OAuth callback URL resolver.
 *
 * The property that matters is stability: every caller and every attempt
 * must get the same redirect URI. Dynamic client registration and Client
 * ID Metadata Documents both pin `redirect_uris` when the client is
 * registered, and the authorization server matches the value exactly on
 * each authorization request, so a URI that varies per attempt makes both
 * mechanisms unusable.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

const resolveCallbackUrl = mock(
  async () => "https://ingress.example/webhooks/oauth/callback",
);

mock.module("../platform-callback-registration.js", () => ({
  resolveCallbackUrl,
}));

mock.module("../public-ingress-urls.js", () => ({
  getOAuthCallbackUrl: () => "https://direct.example/webhooks/oauth/callback",
}));

mock.module("../../config/loader.js", () => ({
  loadConfig: () => ({}),
}));

const { OAUTH_CALLBACK_PATH, resolveOauthCallbackUrl } =
  await import("../oauth-callback-url.js");

afterEach(() => {
  resolveCallbackUrl.mockClear();
});

describe("resolveOauthCallbackUrl", () => {
  test("returns whatever the shared resolver decides", async () => {
    await expect(resolveOauthCallbackUrl()).resolves.toEqual(
      "https://ingress.example/webhooks/oauth/callback",
    );
  });

  test("registers the shared callback path, not a per-caller one", async () => {
    await resolveOauthCallbackUrl();
    const [, callbackPath] = resolveCallbackUrl.mock.calls[0] as unknown[];
    expect(callbackPath).toEqual(OAUTH_CALLBACK_PATH);
    expect(OAUTH_CALLBACK_PATH).toEqual("webhooks/oauth/callback");
  });

  test("every call resolves to the same URL, path, and registration type", async () => {
    // The URI a client registers and the URI it later authorizes with are
    // the same string, which is what an exact-match redirect_uri check
    // needs. Nothing about the caller can vary it: the function takes no
    // arguments.
    const first = await resolveOauthCallbackUrl();
    const second = await resolveOauthCallbackUrl();
    expect(first).toEqual(second);

    const [, pathA, typeA] = resolveCallbackUrl.mock.calls[0] as unknown[];
    const [, pathB, typeB] = resolveCallbackUrl.mock.calls[1] as unknown[];
    expect(pathA).toEqual(pathB);
    expect(typeA).toEqual(typeB);
  });

  test("registers one route type so the platform holds a single admin row", async () => {
    await resolveOauthCallbackUrl();
    const [, , type] = resolveCallbackUrl.mock.calls[0] as unknown[];
    expect(type).toEqual("oauth");
  });

  test("propagates the resolver's failure rather than inventing a URL", async () => {
    // No ingress and no platform connection means there is no URL that
    // would work. Returning a plausible one produces an authorization
    // request whose callback silently never arrives.
    resolveCallbackUrl.mockImplementationOnce(async () => {
      throw new Error("No public base URL configured.");
    });
    await expect(resolveOauthCallbackUrl()).rejects.toThrow(
      /No public base URL/,
    );
  });
});
