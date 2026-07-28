import { describe, expect, mock, test } from "bun:test";

// ── Module mocks (must precede SUT import) ────────────────────────────────────
// startGatewayCallback() dynamically imports these to resolve the public
// callback URL. Stub them so the gateway flow runs without platform infra.

mock.module("../../inbound/platform-callback-registration.js", () => ({
  resolveCallbackUrl: async () =>
    "https://platform.example/v1/gateway/callbacks/abc/webhooks/oauth/callback/",
}));

mock.module("../../inbound/public-ingress-urls.js", () => ({
  getOAuthCallbackUrl: () =>
    "https://platform.example/v1/gateway/callbacks/abc/webhooks/oauth/callback/",
}));

mock.module("../../config/loader.js", () => ({
  loadConfig: () => ({}),
}));

// ── Import SUT after mocks ────────────────────────────────────────────────────

const { McpOAuthProvider } = await import("../mcp-oauth-provider.js");

function newGatewayProvider() {
  return new McpOAuthProvider(
    "comms",
    "https://comms.example/mcp",
    /* interactive */ false,
    "gateway",
  );
}

describe("McpOAuthProvider gateway callback", () => {
  test("stopCallbackServer() before a consumer attaches does not emit an unhandled rejection", async () => {
    // stopCallbackServer() rejects the deferred code promise. When no consumer
    // is attached, that rejection must stay observed so it does not surface as
    // an unhandled rejection, which the daemon treats as fatal.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const provider = newGatewayProvider();

      // Intentionally do NOT consume the returned codePromise — this mirrors the
      // early-exit paths where connect() throws before the OAuth tail is wired up.
      await provider.startCallbackServer();
      provider.stopCallbackServer();

      // Drain the queue so any unhandled rejection has a chance to fire.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const cancelRejections = unhandled.filter(
        (r) =>
          r instanceof Error &&
          r.message.includes("MCP OAuth gateway callback cancelled"),
      );
      expect(cancelRejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("stopCallbackServer() still rejects a consumer that is awaiting the code", async () => {
    const provider = newGatewayProvider();
    await provider.startCallbackServer();

    const codePromise = provider.waitForCode();
    provider.stopCallbackServer();

    await expect(codePromise).rejects.toThrow(
      "MCP OAuth gateway callback cancelled",
    );
  });
});
