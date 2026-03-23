import { beforeEach, describe, expect, mock, test } from "bun:test";

import { VellumAcpClientHandler } from "../acp/client-handler.js";
import { AcpSessionManager } from "../acp/session-manager.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

// ---------------------------------------------------------------------------
// VellumAcpClientHandler tests
// ---------------------------------------------------------------------------

describe("VellumAcpClientHandler", () => {
  let sent: ServerMessage[];
  let sendToVellum: (msg: ServerMessage) => void;
  let handler: VellumAcpClientHandler;

  beforeEach(() => {
    sent = [];
    sendToVellum = (msg) => sent.push(msg);
    handler = new VellumAcpClientHandler(
      "session-1",
      sendToVellum,
      "conv-parent",
    );
    pendingInteractions.clear();
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
    test("sends confirmation_request and resolves when permission is granted", async () => {
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

      // Should have sent a standard confirmation_request with ACP context
      expect(sent).toHaveLength(1);
      const msg = sent[0] as any;
      expect(msg.type).toBe("confirmation_request");
      expect(msg.toolName).toBe("ACP Agent: Run command");
      expect(msg.riskLevel).toBe("medium"); // ACP defaults to medium
      expect(msg.persistentDecisionsAllowed).toBe(false);
      expect(msg.allowlistOptions).toEqual([]);
      // ACP-specific fields passed through for client rendering
      expect(msg.acpToolKind).toBe("execute");
      expect(msg.acpOptions).toEqual([
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ]);

      const requestId = msg.requestId;

      // Resolve via the pendingInteractions tracker (same as POST /v1/confirm)
      const interaction = pendingInteractions.resolve(requestId);
      expect(interaction).toBeDefined();
      expect(interaction!.kind).toBe("acp_confirmation");
      interaction!.directResolve!("allow");

      const result = await resultPromise;
      expect(result).toEqual({
        outcome: { outcome: "selected", optionId: "allow" },
      });
    });

    test("maps deny decision to reject_once option", async () => {
      const resultPromise = handler.requestPermission({
        toolCall: {
          title: "Write file",
          kind: "edit",
          rawInput: { path: "/tmp/test.txt" },
        },
        options: [
          { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
          { optionId: "opt-deny", name: "Deny", kind: "reject_once" },
        ],
      } as any);

      const msg = sent[0] as any;
      expect(msg.riskLevel).toBe("medium"); // ACP defaults to medium

      const interaction = pendingInteractions.resolve(msg.requestId);
      interaction!.directResolve!("deny");

      const result = await resultPromise;
      expect(result).toEqual({
        outcome: { outcome: "selected", optionId: "opt-deny" },
      });
    });

    test("defaults riskLevel to medium for all ACP permissions", async () => {
      handler.requestPermission({
        toolCall: {
          title: "Read file",
          kind: "read",
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      } as any);

      const msg = sent[0] as any;
      expect(msg.riskLevel).toBe("medium");
    });

    test("ACP registration survives sendToVellum overwrite (makeEventSender race)", async () => {
      // Simulate makeEventSender: when sendToVellum is called with a
      // confirmation_request, it overwrites the pendingInteractions entry
      // with a normal "confirmation" (no directResolve). This is what
      // happens in production because sendToVellum goes through the
      // conversation's event sender.
      const overwritingSend = (msg: ServerMessage) => {
        sent.push(msg);
        if ((msg as any).type === "confirmation_request") {
          pendingInteractions.register((msg as any).requestId, {
            conversation: {} as any, // fake conversation
            conversationId: "conv-123",
            kind: "confirmation",
            confirmationDetails: {
              toolName: (msg as any).toolName,
              input: (msg as any).input,
              riskLevel: (msg as any).riskLevel,
              allowlistOptions: [],
              scopeOptions: [],
            },
            // NO directResolve — this is the bug scenario
          });
        }
      };

      // Create handler with the overwriting sender
      const racyHandler = new VellumAcpClientHandler(
        "session-racy",
        overwritingSend,
        "conv-racy",
      );

      const resultPromise = racyHandler.requestPermission({
        toolCall: {
          title: "Write file",
          kind: "edit",
          rawInput: "test",
        },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Deny", kind: "reject_once" },
        ],
      } as any);

      const requestId = (sent[sent.length - 1] as any).requestId;

      // The critical assertion: after requestPermission completes setup,
      // the pendingInteractions entry must be the ACP one with directResolve,
      // NOT the overwritten "confirmation" without it.
      const interaction = pendingInteractions.resolve(requestId);
      expect(interaction).toBeDefined();
      expect(interaction!.kind).toBe("acp_confirmation");
      expect(interaction!.directResolve).toBeDefined();

      // Resolve it — this would fail silently if the overwrite won
      interaction!.directResolve!("allow");

      const result = await resultPromise;
      expect(result).toEqual({
        outcome: { outcome: "selected", optionId: "yes" },
      });
    });
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
