import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
let mockIsConnected = true;
let mockLastError: Error | null = null;

mock.module("../mcp/client.js", () => ({
  McpClient: class {
    get isConnected() {
      return mockIsConnected;
    }
    get lastError() {
      return mockLastError;
    }
    connect = mockConnect;
    disconnect = mockDisconnect;
  },
}));

const { checkServerHealth } = await import("../cli/commands/mcp.js");

const serverConfig = (overrides = {}) => ({
  transport: {
    type: "streamable-http" as const,
    url: "https://example.com/mcp",
  },
  enabled: true,
  defaultRiskLevel: "high" as const,
  maxTools: 20,
  ...overrides,
});

describe("checkServerHealth", () => {
  beforeEach(() => {
    mockConnect.mockReset();
    mockDisconnect.mockReset();
    mockIsConnected = true;
    mockLastError = null;
  });

  test("returns Connected when server connects successfully", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockDisconnect.mockResolvedValue(undefined);

    const result = await checkServerHealth("test", serverConfig());
    expect(result).toContain("Connected");
    expect(mockDisconnect).toHaveBeenCalled();
  });

  test("returns Needs authentication when isConnected is false and no lastError", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockIsConnected = false;

    const result = await checkServerHealth("test", serverConfig());
    expect(result).toContain("Needs authentication");
  });

  test("returns Error when connect fails with lastError", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockIsConnected = false;
    mockLastError = new Error("Connection refused");
    mockDisconnect.mockResolvedValue(undefined);

    const result = await checkServerHealth("test", serverConfig());
    expect(result).toContain("Error");
    expect(result).toContain("Connection refused");
  });

  test("returns Timed out when connect hangs", async () => {
    mockConnect.mockImplementation(() => new Promise(() => {}));
    mockDisconnect.mockResolvedValue(undefined);

    const result = await checkServerHealth("test", serverConfig(), 100);
    expect(result).toContain("Timed out");
  });
});
