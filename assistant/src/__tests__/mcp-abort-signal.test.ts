import { describe, expect, jest, mock, test } from "bun:test";

// Mock secure-keys so McpOAuthProvider doesn't try to access the credential store
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: jest.fn().mockResolvedValue(null),
  setSecureKeyAsync: jest.fn().mockResolvedValue(true),
  deleteSecureKeyAsync: jest.fn().mockResolvedValue("deleted"),
}));

const { McpClient } = await import("../mcp/client.js");
const { McpServerManager } = await import("../mcp/manager.js");
const { createMcpTool } = await import("../tools/mcp/mcp-tool-factory.js");

describe("MCP AbortSignal threading", () => {
  describe("McpClient.callTool", () => {
    test("forwards signal to the SDK client.callTool options", async () => {
      const client = new McpClient("test-server");

      const callToolSpy = jest.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      });

      // Monkey-patch to mark as connected and capture callTool args
      (client as any).connected = true;
      (client as any).client = { callTool: callToolSpy };

      const ac = new AbortController();
      await client.callTool("my-tool", { foo: "bar" }, ac.signal);

      expect(callToolSpy).toHaveBeenCalledTimes(1);
      const [params, resultSchema, options] = callToolSpy.mock.calls[0];
      expect(params).toEqual({ name: "my-tool", arguments: { foo: "bar" } });
      expect(resultSchema).toBeUndefined();
      expect(options).toEqual({ signal: ac.signal });
    });

    test("passes undefined signal cleanly (no regression)", async () => {
      const client = new McpClient("test-server");

      const callToolSpy = jest.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      });

      (client as any).connected = true;
      (client as any).client = { callTool: callToolSpy };

      await client.callTool("my-tool", { foo: "bar" });

      expect(callToolSpy).toHaveBeenCalledTimes(1);
      const [_params, _resultSchema, options] = callToolSpy.mock.calls[0];
      expect(options).toEqual({ signal: undefined });
    });

    test("already-aborted signal causes the SDK call to reject", async () => {
      const client = new McpClient("test-server");

      const callToolSpy = jest
        .fn()
        .mockImplementation((_p: any, _r: any, opts: any) => {
          if (opts?.signal?.aborted) {
            return Promise.reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          }
          return Promise.resolve({
            content: [{ type: "text", text: "ok" }],
            isError: false,
          });
        });

      (client as any).connected = true;
      (client as any).client = { callTool: callToolSpy };

      const ac = new AbortController();
      ac.abort();

      await expect(client.callTool("my-tool", {}, ac.signal)).rejects.toThrow(
        "The operation was aborted.",
      );
    });
  });

  describe("McpServerManager.callTool", () => {
    test("forwards signal to the underlying McpClient.callTool", async () => {
      const manager = new McpServerManager();

      const callToolSpy = jest.fn().mockResolvedValue({
        content: "result",
        isError: false,
      });

      const fakeClient = { callTool: callToolSpy, serverId: "test-server" };
      (manager as any).clients.set("test-server", fakeClient);

      const ac = new AbortController();
      await manager.callTool("test-server", "my-tool", { x: 1 }, ac.signal);

      expect(callToolSpy).toHaveBeenCalledWith("my-tool", { x: 1 }, ac.signal);
    });

    test("passes undefined signal when not provided", async () => {
      const manager = new McpServerManager();

      const callToolSpy = jest.fn().mockResolvedValue({
        content: "result",
        isError: false,
      });

      const fakeClient = { callTool: callToolSpy, serverId: "test-server" };
      (manager as any).clients.set("test-server", fakeClient);

      await manager.callTool("test-server", "my-tool", { x: 1 });

      expect(callToolSpy).toHaveBeenCalledWith("my-tool", { x: 1 }, undefined);
    });
  });

  describe("createMcpTool execute", () => {
    test("threads context.signal through manager.callTool", async () => {
      const callToolSpy = jest.fn().mockResolvedValue({
        content: "tool result",
        isError: false,
      });

      const fakeManager = { callTool: callToolSpy } as any;

      const tool = createMcpTool(
        {
          name: "my-tool",
          description: "A test tool",
          inputSchema: { type: "object", properties: {} },
        },
        "test-server",
        {
          transport: { type: "stdio", command: "echo", args: [] },
          enabled: true,
          defaultRiskLevel: "high",
          maxTools: 100,
        },
        fakeManager,
      );

      const ac = new AbortController();
      await tool.execute(
        { someArg: "value" },
        {
          workingDir: "/tmp",
          conversationId: "conv-1",
          signal: ac.signal,
          trustClass: "guardian",
        },
      );

      expect(callToolSpy).toHaveBeenCalledWith(
        "test-server",
        "my-tool",
        { someArg: "value" },
        ac.signal,
      );
    });

    test("passes undefined signal when context has no signal", async () => {
      const callToolSpy = jest.fn().mockResolvedValue({
        content: "tool result",
        isError: false,
      });

      const fakeManager = { callTool: callToolSpy } as any;

      const tool = createMcpTool(
        {
          name: "my-tool",
          description: "A test tool",
          inputSchema: { type: "object", properties: {} },
        },
        "test-server",
        {
          transport: { type: "stdio", command: "echo", args: [] },
          enabled: true,
          defaultRiskLevel: "high",
          maxTools: 100,
        },
        fakeManager,
      );

      await tool.execute(
        { someArg: "value" },
        {
          workingDir: "/tmp",
          conversationId: "conv-1",
          trustClass: "guardian",
        },
      );

      expect(callToolSpy).toHaveBeenCalledWith(
        "test-server",
        "my-tool",
        { someArg: "value" },
        undefined,
      );
    });
  });
});
