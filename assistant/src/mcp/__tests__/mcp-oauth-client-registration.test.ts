/**
 * Reuse and invalidation of the stored dynamic client registration.
 *
 * Dynamic registration writes a record on the authorization server, so
 * registering per attempt leaves records behind that nobody cleans up. The
 * stored registration is therefore reused, and only withheld when it
 * provably no longer applies. Both halves matter: reusing one bound to a
 * stale redirect URI produces authorization requests the server rejects,
 * and re-registering unnecessarily is the accumulation this exists to stop.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const CALLBACK_URL =
  "https://platform.example/v1/gateway/callbacks/abc/webhooks/oauth/callback/";

let resolvedCallbackUrl = CALLBACK_URL;

mock.module("../../inbound/platform-callback-registration.js", () => ({
  resolveCallbackUrl: async () => resolvedCallbackUrl,
}));

mock.module("../../inbound/public-ingress-urls.js", () => ({
  getOAuthCallbackUrl: () => resolvedCallbackUrl,
}));

mock.module("../../config/loader.js", () => ({
  loadConfig: () => ({}),
}));

/** In-memory stand-in for the credential store. */
const store = new Map<string, string>();

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (k: string) => store.get(k) ?? null,
  setSecureKeyAsync: async (k: string, v: string) => {
    store.set(k, v);
    return true;
  },
  deleteSecureKeyAsync: async (k: string) =>
    store.delete(k) ? "deleted" : "not-found",
}));

mock.module("../../daemon/identity-helpers.js", () => ({
  getAssistantName: () => "Jarvis",
}));

mock.module("../../config/env.js", () => ({
  getPlatformAssistantId: () => "019d6d4f-6dbd-779f-91d3-cb273b9429a5",
}));

const { McpOAuthProvider } = await import("../mcp-oauth-provider.js");

const REGISTRATION = { client_id: "generated-client-id" };

function newProvider() {
  return new McpOAuthProvider(
    "unabyss",
    "https://mcp.unabyss.com",
    /* interactive */ false,
  );
}

/** Seed discovery state the way the SDK would after running discovery. */
async function seedDiscovery(
  provider: InstanceType<typeof McpOAuthProvider>,
  issuer: string,
): Promise<void> {
  await provider.saveDiscoveryState({
    authorizationServerUrl: issuer,
    authorizationServerMetadata: { issuer },
  } as never);
}

/** Run one registration the way a completed flow would. */
async function register(issuer = "https://mcp.unabyss.com"): Promise<void> {
  const provider = newProvider();
  await provider.startCallbackServer();
  await seedDiscovery(provider, issuer);
  await provider.saveClientInformation(REGISTRATION as never);
  provider.stopCallbackServer();
}

beforeEach(() => {
  store.clear();
  resolvedCallbackUrl = CALLBACK_URL;
});

describe("McpOAuthProvider client registration reuse", () => {
  test("a stored registration is reused on the next flow", async () => {
    await register();

    const next = newProvider();
    await next.startCallbackServer();
    await seedDiscovery(next, "https://mcp.unabyss.com");

    // Returning the stored value is what keeps the server from accruing a
    // fresh client record on every `assistant mcp auth`.
    expect(await next.clientInformation()).toEqual(REGISTRATION as never);
  });

  test("no stored registration means the SDK registers", async () => {
    const provider = newProvider();
    await provider.startCallbackServer();
    expect(await provider.clientInformation()).toBeUndefined();
  });

  test("a changed redirect URI withholds the registration", async () => {
    await register();

    // The assistant moved, so its callback URL moved with it. The stored
    // client is registered for the old one and the server would reject it.
    resolvedCallbackUrl = "https://other.example/webhooks/oauth/callback";
    const next = newProvider();
    await next.startCallbackServer();
    await seedDiscovery(next, "https://mcp.unabyss.com");

    expect(await next.clientInformation()).toBeUndefined();
  });

  test("a changed authorization server withholds the registration", async () => {
    await register("https://auth.unabyss.com");

    const next = newProvider();
    await next.startCallbackServer();
    await seedDiscovery(next, "https://different-auth.example");

    expect(await next.clientInformation()).toBeUndefined();
  });

  test("a silent reconnect reuses the registration without a redirect URI", async () => {
    await register();

    // `McpClient.connect` never prepares a callback, so `_redirectUrl` is
    // unset. Treating that as a mismatch would turn every background
    // reconnect into a registration.
    const silent = newProvider();
    await seedDiscovery(silent, "https://mcp.unabyss.com");

    expect(await silent.clientInformation()).toEqual(REGISTRATION as never);
  });

  test("a registration stored before bindings existed is kept", async () => {
    // Upgrading must not invalidate every existing registration at once.
    store.set(
      "mcp:unabyss:client_info",
      JSON.stringify({ client_id: "legacy" }),
    );

    const provider = newProvider();
    await provider.startCallbackServer();
    await seedDiscovery(provider, "https://mcp.unabyss.com");

    expect(await provider.clientInformation()).toEqual({
      client_id: "legacy",
    } as never);
  });

  test("invalidating the client drops its binding too", async () => {
    await register();
    expect(store.has("mcp:unabyss:client_binding")).toBe(true);

    const provider = newProvider();
    await provider.invalidateCredentials("client");

    expect(store.has("mcp:unabyss:client_info")).toBe(false);
    // A surviving binding would let the next registration inherit the
    // previous one's issuer and redirect URI.
    expect(store.has("mcp:unabyss:client_binding")).toBe(false);
  });
});

describe("McpOAuthProvider client metadata", () => {
  test("registers under the assistant's own name", async () => {
    const provider = newProvider();
    expect(provider.clientMetadata.client_name).toEqual("Jarvis");
  });

  test("carries the assistant id as software_id", async () => {
    const provider = newProvider();
    expect(provider.clientMetadata.software_id).toEqual(
      "019d6d4f-6dbd-779f-91d3-cb273b9429a5",
    );
  });

  test("presents an anonymously fetchable logo", async () => {
    // The consent screen loads this without credentials, so it cannot be
    // the assistant's own avatar, which is served behind authentication.
    const provider = newProvider();
    expect(provider.clientMetadata.logo_uri).toEqual(
      "https://www.vellum.ai/favicon.svg",
    );
  });

  test("registers the resolved callback URL as the redirect URI", async () => {
    const provider = newProvider();
    await provider.startCallbackServer();
    expect(provider.clientMetadata.redirect_uris).toEqual([CALLBACK_URL]);
  });
});
