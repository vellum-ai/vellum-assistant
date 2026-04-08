import { describe, expect, jest, mock, test } from "bun:test";

// Mock secure-keys so McpOAuthProvider doesn't try to access the credential store
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: jest.fn().mockResolvedValue(null),
  setSecureKeyAsync: jest.fn().mockResolvedValue(true),
  deleteSecureKeyAsync: jest.fn().mockResolvedValue("deleted"),
}));

// Mock platform-callback-registration (imported by client.ts)
mock.module("../inbound/platform-callback-registration.js", () => ({
  shouldUsePlatformCallbacks: jest.fn().mockReturnValue(false),
}));

const { McpClient } = await import("../mcp/client.js");
const { McpOAuthProvider } = await import("../mcp/mcp-oauth-provider.js");

/**
 * Mimics the SDK's StreamableHTTPError which has a `.code` property
 * containing the HTTP status code, but doesn't include it in `.message`.
 */
class FakeStreamableHTTPError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(`Streamable HTTP error: ${message}`);
    this.code = code;
  }
}

const httpTransport = {
  type: "streamable-http" as const,
  url: "https://example.com/mcp",
};

describe("McpClient auth error detection", () => {
  test("treats StreamableHTTPError with code 401 as auth error (does not throw)", async () => {
    const client = new McpClient("test-server");

    // Monkey-patch createTransport to throw a 401 StreamableHTTPError
    (client as any).createTransport = () => ({});
    (client as any).client = {
      connect: () => {
        throw new FakeStreamableHTTPError(
          401,
          'Error POSTing to endpoint: {"error":"invalid_token"}',
        );
      },
      close: async () => {},
    };

    // Should NOT throw — auth errors are swallowed, isConnected stays false
    await client.connect(httpTransport);
    expect(client.isConnected).toBe(false);
  });

  test("treats StreamableHTTPError with code 403 as auth error (does not throw)", async () => {
    const client = new McpClient("test-server");

    (client as any).createTransport = () => ({});
    (client as any).client = {
      connect: () => {
        throw new FakeStreamableHTTPError(403, "Forbidden");
      },
      close: async () => {},
    };

    await client.connect(httpTransport);
    expect(client.isConnected).toBe(false);
  });

  test("swallows non-auth StreamableHTTPError (connect never throws)", async () => {
    const client = new McpClient("test-server");

    (client as any).createTransport = () => ({});
    (client as any).client = {
      connect: () => {
        throw new FakeStreamableHTTPError(500, "Internal Server Error");
      },
      close: async () => {},
    };

    // Non-auth errors are logged but never propagated — daemon keeps running
    await client.connect(httpTransport);
    expect(client.isConnected).toBe(false);
  });

  test("treats error message containing 'unauthorized' as auth error", async () => {
    const client = new McpClient("test-server");

    (client as any).createTransport = () => ({});
    (client as any).client = {
      connect: () => {
        throw new Error("unauthorized request");
      },
      close: async () => {},
    };

    await client.connect(httpTransport);
    expect(client.isConnected).toBe(false);
  });

  test("treats SDK fetchToken 'authorizationCode is required' error as auth error", async () => {
    const client = new McpClient("test-server");

    (client as any).createTransport = () => ({});
    (client as any).client = {
      connect: () => {
        throw new Error(
          "Either provider.prepareTokenRequest() or authorizationCode is required",
        );
      },
      close: async () => {},
    };

    await client.connect(httpTransport);
    expect(client.isConnected).toBe(false);
  });
});

describe("McpOAuthProvider redirectUrl", () => {
  test("non-interactive provider sets placeholder redirectUrl so SDK uses auth_code flow", () => {
    const provider = new McpOAuthProvider(
      "test-server",
      "https://example.com/mcp",
      /* interactive */ false,
    );
    // Must be truthy so SDK's `!provider.redirectUrl` is false
    expect(provider.redirectUrl).toBeTruthy();
  });

  test("interactive provider leaves redirectUrl undefined until startCallbackServer()", () => {
    const provider = new McpOAuthProvider(
      "test-server",
      "https://example.com/mcp",
      /* interactive */ true,
    );
    expect(provider.redirectUrl).toBeUndefined();
  });
});
