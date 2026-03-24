import { describe, expect, jest, mock, test } from "bun:test";

// Mock secure-keys so McpOAuthProvider doesn't try to access the credential store
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: jest.fn().mockResolvedValue(null),
  setSecureKeyAsync: jest.fn().mockResolvedValue(true),
  deleteSecureKeyAsync: jest.fn().mockResolvedValue("deleted"),
}));

const { McpClient } = await import("../mcp/client.js");

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

  test("rethrows non-auth StreamableHTTPError for HTTP transports", async () => {
    const client = new McpClient("test-server");

    (client as any).createTransport = () => ({});
    (client as any).client = {
      connect: () => {
        throw new FakeStreamableHTTPError(500, "Internal Server Error");
      },
      close: async () => {},
    };

    await expect(client.connect(httpTransport)).rejects.toThrow(
      "Internal Server Error",
    );
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
});
