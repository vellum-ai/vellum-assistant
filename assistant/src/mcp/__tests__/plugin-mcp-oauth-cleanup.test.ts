import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

const listSecureKeysAsync = jest.fn(async () => ({
  accounts: [] as string[],
  unreachable: false,
}));
const deleteSecureKeyAsync = jest.fn(
  async (_key: string): Promise<"deleted" | "not-found" | "error"> => "deleted",
);

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyAsync: jest.fn(async () => null),
  setSecureKeyAsync: jest.fn(async () => true),
  deleteSecureKeyAsync,
  listSecureKeysAsync,
}));

const { deletePluginMcpOAuthCredentials } =
  await import("../mcp-oauth-provider.js");

describe("plugin MCP OAuth credential cleanup", () => {
  beforeEach(() => {
    listSecureKeysAsync.mockReset();
    listSecureKeysAsync.mockImplementation(async () => ({
      accounts: [],
      unreachable: false,
    }));
    deleteSecureKeyAsync.mockReset();
    deleteSecureKeyAsync.mockImplementation(async () => "deleted" as const);
  });

  test("deletes only the exact plugin owner prefix", async () => {
    listSecureKeysAsync.mockImplementationOnce(async () => ({
      accounts: [
        "mcp-plugin/v1/cGx1Z2lu/client/digest/tokens",
        "mcp-plugin/v1/cGx1Z2lu/client/digest/discovery",
        "mcp-plugin/v1/cGx1Z2luMg/client/digest/tokens",
        "mcp:plugin:tokens",
      ],
      unreachable: false,
    }));

    const result = await deletePluginMcpOAuthCredentials("plugin");

    expect(deleteSecureKeyAsync.mock.calls.map(([key]) => key)).toEqual([
      "mcp-plugin/v1/cGx1Z2lu/client/digest/tokens",
      "mcp-plugin/v1/cGx1Z2lu/client/digest/discovery",
    ]);
    expect(result).toEqual({
      ok: true,
      unreachable: false,
      matchedKeys: [
        "mcp-plugin/v1/cGx1Z2lu/client/digest/tokens",
        "mcp-plugin/v1/cGx1Z2lu/client/digest/discovery",
      ],
      failedKeys: [],
    });
  });

  test("does not attempt deletion when credential storage is unreachable", async () => {
    listSecureKeysAsync.mockImplementationOnce(async () => ({
      accounts: [],
      unreachable: true,
    }));

    const result = await deletePluginMcpOAuthCredentials("plugin");

    expect(deleteSecureKeyAsync).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      unreachable: true,
      matchedKeys: [],
      failedKeys: [],
    });
  });

  test("reports any matched key that could not be deleted", async () => {
    const key = "mcp-plugin/v1/cGx1Z2lu/client/digest/tokens";
    listSecureKeysAsync.mockImplementationOnce(async () => ({
      accounts: [key],
      unreachable: false,
    }));
    deleteSecureKeyAsync.mockImplementationOnce(async () => "error" as const);

    const result = await deletePluginMcpOAuthCredentials("plugin");

    expect(result.ok).toBe(false);
    expect(result.failedKeys).toEqual([key]);
  });

  test("reports a rejected matched-key deletion as a failure", async () => {
    const key = "mcp-plugin/v1/cGx1Z2lu/client/digest/tokens";
    listSecureKeysAsync.mockImplementationOnce(async () => ({
      accounts: [key],
      unreachable: false,
    }));
    deleteSecureKeyAsync.mockImplementationOnce(async () => {
      throw new Error("backend failed");
    });

    const result = await deletePluginMcpOAuthCredentials("plugin");

    expect(result.ok).toBe(false);
    expect(result.unreachable).toBe(false);
    expect(result.failedKeys).toEqual([key]);
  });
});
