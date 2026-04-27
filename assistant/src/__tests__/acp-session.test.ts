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
    test("suppresses ACP confirmation UI and chooses the allow option (auto-allow)", async () => {
      const result = await handler.requestPermission({
        toolCall: {
          title: "Read file",
          kind: "read",
          rawInput: "/tmp/example.txt",
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      } as any);

      expect(result).toEqual({
        outcome: { outcome: "selected", optionId: "allow" },
      });
      expect(sent).toHaveLength(0);
      expect(handler.pendingRequestIds.size).toBe(0);
    });

    test("suppresses ACP confirmation UI and cancels when no allow option exists", async () => {
      const result = await handler.requestPermission({
        toolCall: {
          title: "Read file",
          kind: "read",
          rawInput: "/tmp/example.txt",
        },
        options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
      } as any);

      expect(result).toEqual({
        outcome: { outcome: "cancelled" },
      });
      expect(sent).toHaveLength(0);
      expect(handler.pendingRequestIds.size).toBe(0);
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

  describe("session cleanup after prompt", () => {
    test("completed session is removed from the session map", async () => {
      let resolvePrompt: (v: { stopReason: string }) => void;
      const promptPromise = new Promise<{ stopReason: string }>((r) => {
        resolvePrompt = r;
      });

      const manager = new AcpSessionManager(1);
      const sendToVellum = mock(() => {});

      // Inject a fake session directly into the manager to avoid needing
      // a real child process.
      const fakeProcess = {
        prompt: () => promptPromise,
        kill: mock(() => {}),
        spawn: mock(() => {}),
        initialize: mock(() => Promise.resolve()),
        createSession: mock(() => Promise.resolve("proto-session")),
        cancel: mock(() => Promise.resolve()),
      };
      const fakeHandler = new VellumAcpClientHandler(
        "test-session",
        sendToVellum,
        "conv-1",
      );

      // Access private sessions map via any cast
      const sessions = (manager as any).sessions as Map<string, any>;
      const entry = {
        process: fakeProcess,
        state: {
          id: "test-session",
          agentId: "agent-1",
          acpSessionId: "proto-session",
          parentConversationId: "conv-1",
          status: "running",
          startedAt: Date.now(),
        },
        clientHandler: fakeHandler,
        sendToVellum,
        currentPrompt: null as any,
        parentConversationId: "conv-1",
        cwd: "/tmp",
      };
      sessions.set("test-session", entry);

      // Fire the prompt in the background via the private method
      const bgPromise = (manager as any).firePromptInBackground(
        "test-session",
        entry,
        "proto-session",
        "do something",
      );
      entry.currentPrompt = bgPromise;

      // Session exists before completion
      expect((manager.getStatus() as any[]).length).toBe(1);

      // Complete the prompt
      resolvePrompt!({ stopReason: "end_turn" });
      await bgPromise;

      // Session should be cleaned up
      expect((manager.getStatus() as any[]).length).toBe(0);
      expect(fakeProcess.kill).toHaveBeenCalled();
    });

    test("failed session is removed from the session map", async () => {
      const manager = new AcpSessionManager(1);
      const sendToVellum = mock(() => {});

      let rejectPrompt: (e: Error) => void;
      const promptPromise = new Promise<{ stopReason: string }>((_r, rej) => {
        rejectPrompt = rej;
      });

      const fakeProcess = {
        prompt: () => promptPromise,
        kill: mock(() => {}),
      };
      const fakeHandler = new VellumAcpClientHandler(
        "test-session-2",
        sendToVellum,
        "conv-2",
      );

      const sessions = (manager as any).sessions as Map<string, any>;
      const entry = {
        process: fakeProcess,
        state: {
          id: "test-session-2",
          agentId: "agent-1",
          acpSessionId: "proto-session-2",
          parentConversationId: "conv-2",
          status: "running",
          startedAt: Date.now(),
        },
        clientHandler: fakeHandler,
        sendToVellum,
        currentPrompt: null as any,
        parentConversationId: "conv-2",
        cwd: "/tmp",
      };
      sessions.set("test-session-2", entry);

      const bgPromise = (manager as any).firePromptInBackground(
        "test-session-2",
        entry,
        "proto-session-2",
        "do something",
      );
      entry.currentPrompt = bgPromise;

      expect((manager.getStatus() as any[]).length).toBe(1);

      // Fail the prompt
      rejectPrompt!(new Error("agent crashed"));
      await bgPromise;

      // Session should be cleaned up even on failure
      expect((manager.getStatus() as any[]).length).toBe(0);
      expect(fakeProcess.kill).toHaveBeenCalled();
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
