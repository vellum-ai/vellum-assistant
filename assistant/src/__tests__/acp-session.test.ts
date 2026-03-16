import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  resolvePermission,
  VellumAcpClientHandler,
} from "../acp/client-handler.js";
import { AcpSessionManager } from "../acp/session-manager.js";
import type { ServerMessage } from "../daemon/message-protocol.js";

// ---------------------------------------------------------------------------
// VellumAcpClientHandler tests
// ---------------------------------------------------------------------------

describe("VellumAcpClientHandler", () => {
  let sent: ServerMessage[];
  let sendToVellum: (msg: ServerMessage) => void;
  let pendingPermissions: Map<string, { resolve: (optionId: string) => void }>;
  let handler: VellumAcpClientHandler;

  beforeEach(() => {
    sent = [];
    sendToVellum = (msg) => sent.push(msg);
    pendingPermissions = new Map();
    handler = new VellumAcpClientHandler(
      "session-1",
      sendToVellum,
      pendingPermissions,
    );
  });

  describe("sessionUpdate", () => {
    test("dispatches agent_message_chunk with extracted text", async () => {
      await handler.sessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        } as any,
      });

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: "acp_session_update",
        acpSessionId: "session-1",
        updateType: "agent_message_chunk",
        content: "hello",
      });
    });

    test("dispatches user_message_chunk with its own updateType", async () => {
      await handler.sessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "user text" },
        } as any,
      });

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: "acp_session_update",
        updateType: "user_message_chunk",
        content: "user text",
      });
    });

    test("dispatches tool_call update", async () => {
      await handler.sessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "Read file",
          kind: "read",
          status: "running",
        } as any,
      });

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: "acp_session_update",
        updateType: "tool_call",
        toolCallId: "tc-1",
        toolTitle: "Read file",
        toolKind: "read",
        toolStatus: "running",
      });
    });

    test("dispatches tool_call_update", async () => {
      await handler.sessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-2",
          status: "completed",
          content: { result: "ok" },
        } as any,
      });

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: "acp_session_update",
        updateType: "tool_call_update",
        toolCallId: "tc-2",
        toolStatus: "completed",
      });
    });

    test("dispatches plan update", async () => {
      const entries = [{ step: "Step 1" }];
      await handler.sessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "plan",
          entries,
        } as any,
      });

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: "acp_session_update",
        updateType: "plan",
        content: JSON.stringify(entries),
      });
    });

    test("ignores unhandled session update types", async () => {
      await handler.sessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "usage_update",
          usage: { tokens: 100 },
        } as any,
      });

      expect(sent).toHaveLength(0);
    });

    test("returns empty string when content has no text field", async () => {
      await handler.sessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "image" },
        } as any,
      });

      expect(sent).toHaveLength(1);
      expect((sent[0] as any).content).toBe("");
    });
  });

  describe("requestPermission", () => {
    test("sends permission request and resolves when permission is granted", async () => {
      const resultPromise = handler.requestPermission({
        toolCall: {
          title: "Run command",
          kind: "execute",
          rawInput: "ls -la",
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      } as any);

      // Should have sent a permission request
      expect(sent).toHaveLength(1);
      const msg = sent[0] as any;
      expect(msg.type).toBe("acp_permission_request");
      expect(msg.acpSessionId).toBe("session-1");
      expect(msg.toolTitle).toBe("Run command");
      expect(msg.toolKind).toBe("execute");
      expect(msg.options).toHaveLength(2);

      // A pending permission should exist
      expect(pendingPermissions.size).toBe(1);
      const requestId = msg.requestId;

      // Resolve the permission
      resolvePermission(pendingPermissions, requestId, "allow");

      const result = await resultPromise;
      expect(result).toEqual({
        outcome: { outcome: "selected", optionId: "allow" },
      });
      expect(pendingPermissions.size).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// resolvePermission standalone tests
// ---------------------------------------------------------------------------

describe("resolvePermission", () => {
  test("resolves and removes the pending entry", () => {
    let resolved = "";
    const pending = new Map<string, { resolve: (id: string) => void }>();
    pending.set("req-1", { resolve: (id) => (resolved = id) });

    resolvePermission(pending, "req-1", "allow");

    expect(resolved).toBe("allow");
    expect(pending.size).toBe(0);
  });

  test("is a no-op when request ID is not found", () => {
    const pending = new Map<string, { resolve: (id: string) => void }>();
    // Should not throw
    resolvePermission(pending, "nonexistent", "allow");
    expect(pending.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AcpSessionManager tests
// ---------------------------------------------------------------------------

describe("AcpSessionManager", () => {
  describe("concurrency limit", () => {
    test("rejects spawn when max concurrent sessions reached", async () => {
      const manager = new AcpSessionManager(0);
      const sendToVellum = mock(() => {});

      await expect(
        manager.spawn(
          "agent-1",
          { command: "echo", args: ["hi"] },
          "do something",
          "/tmp",
          "parent-1",
          sendToVellum,
        ),
      ).rejects.toThrow(/concurrency limit reached/i);
    });
  });

  describe("close / getStatus on missing sessions", () => {
    test("close throws for unknown session", () => {
      const manager = new AcpSessionManager(5);
      expect(() => manager.close("nonexistent")).toThrow(/not found/);
    });

    test("getStatus throws for unknown specific session", () => {
      const manager = new AcpSessionManager(5);
      expect(() => manager.getStatus("nonexistent")).toThrow(/not found/);
    });

    test("getStatus returns empty array when no sessions exist", () => {
      const manager = new AcpSessionManager(5);
      expect(manager.getStatus()).toEqual([]);
    });
  });

  describe("cancel on missing session", () => {
    test("throws for unknown session", async () => {
      const manager = new AcpSessionManager(5);
      await expect(manager.cancel("nonexistent")).rejects.toThrow(/not found/);
    });
  });

  describe("steer on missing session", () => {
    test("throws for unknown session", async () => {
      const manager = new AcpSessionManager(5);
      await expect(manager.steer("nonexistent", "go left")).rejects.toThrow(
        /not found/,
      );
    });
  });

  describe("resolvePermission", () => {
    test("logs warning for unknown request ID (no throw)", () => {
      const manager = new AcpSessionManager(5);
      // Should not throw — just logs a warning
      manager.resolvePermission("unknown-req", "allow");
    });
  });

  describe("closeAll / dispose", () => {
    test("closeAll on empty manager does not throw", () => {
      const manager = new AcpSessionManager(5);
      expect(() => manager.closeAll()).not.toThrow();
    });

    test("dispose on empty manager does not throw", () => {
      const manager = new AcpSessionManager(5);
      expect(() => manager.dispose()).not.toThrow();
    });
  });
});
