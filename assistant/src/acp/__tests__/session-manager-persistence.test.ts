/**
 * Tests for AcpSessionManager's terminal-state persistence pipeline:
 * the per-session ring buffer, the `acp_session_history` row written on
 * terminal transition, and the buffer eviction policy.
 *
 * These tests inject a fake AcpAgentProcess directly into the session map
 * to drive completion/failure without spawning a real child process —
 * matching the `session cleanup after prompt` style in `acp-session.test.ts`.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { ServerMessage } from "../../daemon/message-protocol.js";
import type { AcpSessionUpdate } from "../../daemon/message-types/acp.js";
import { getSqlite } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { VellumAcpClientHandler } from "../client-handler.js";
import { AcpSessionManager } from "../session-manager.js";
import type { AcpUsageSnapshot } from "../types.js";
import {
  clearHistory,
  insertHistoryRow,
  readHistoryRow,
} from "./helpers/acp-history-db.js";
await initializeDb();

/**
 * Builds a manager with a fake session pre-injected and returns the handles
 * needed to drive terminal transitions in tests.
 */
function buildSessionWithFakeProcess(opts: {
  id: string;
  agentId: string;
  protocolSessionId: string;
  parentConversationId: string;
  cwd?: string;
  task?: string;
  parentToolUseId?: string;
  latestUsage?: AcpUsageSnapshot;
}): {
  manager: AcpSessionManager;
  resolvePrompt: (v: {
    stopReason: string;
    usage?: { inputTokens: number; outputTokens: number };
  }) => void;
  rejectPrompt: (e: Error) => void;
  emitUpdate: (update: AcpSessionUpdate) => void;
} {
  const manager = new AcpSessionManager(1);
  const sent: ServerMessage[] = [];
  const sendToVellum = (msg: ServerMessage) => sent.push(msg);

  type PromptResolution = {
    stopReason: string;
    usage?: { inputTokens: number; outputTokens: number };
  };
  let resolvePrompt!: (v: PromptResolution) => void;
  let rejectPrompt!: (e: Error) => void;
  const promptPromise = new Promise<PromptResolution>((res, rej) => {
    resolvePrompt = res;
    rejectPrompt = rej;
  });

  const fakeProcess = {
    prompt: () => promptPromise,
    kill: () => {},
    spawn: () => {},
    initialize: () => Promise.resolve(),
    createSession: () => Promise.resolve(opts.protocolSessionId),
    cancel: () => Promise.resolve(),
    markStderr: () => 0,
    stderrSince: () => "",
  };

  // Match spawn()'s wiring: pre-create the buffer and route emitted updates
  // through the wrapped sender so appendToBuffer fires for each event.
  const sessions = (manager as unknown as { sessions: Map<string, unknown> })
    .sessions;
  const eventBuffers = (
    manager as unknown as { eventBuffers: Map<string, unknown[]> }
  ).eventBuffers;
  eventBuffers.set(opts.id, []);

  const wrappedSend = (msg: ServerMessage) => {
    if (msg.type === "acp_session_update") {
      (
        manager as unknown as {
          appendToBuffer: (id: string, u: AcpSessionUpdate) => void;
        }
      ).appendToBuffer(opts.id, msg);
    }
    sendToVellum(msg);
  };

  const clientHandler = new VellumAcpClientHandler(
    opts.id,
    wrappedSend,
    opts.parentConversationId,
  );

  const entry = {
    process: fakeProcess,
    state: {
      id: opts.id,
      agentId: opts.agentId,
      acpSessionId: opts.protocolSessionId,
      status: "running",
      startedAt: Date.now(),
      task: opts.task,
      parentToolUseId: opts.parentToolUseId,
      latestUsage: opts.latestUsage,
    },
    clientHandler,
    sendToVellum: wrappedSend,
    currentPrompt: null as Promise<unknown> | null,
    parentConversationId: opts.parentConversationId,
    cwd: opts.cwd ?? "/tmp",
    command: "claude-agent-acp",
  };
  sessions.set(opts.id, entry);

  // Fire the prompt via the private method, matching spawn()'s wiring.
  const bgPromise = (
    manager as unknown as {
      firePromptInBackground: (
        id: string,
        e: typeof entry,
        protoId: string,
        msg: string,
      ) => Promise<unknown>;
    }
  ).firePromptInBackground(opts.id, entry, opts.protocolSessionId, "do work");
  entry.currentPrompt = bgPromise;

  // Helper that pushes an update through the wrapped sender — exactly
  // matching what VellumAcpClientHandler.sessionUpdate does.
  const emitUpdate = (update: AcpSessionUpdate) => {
    wrappedSend(update);
  };

  return {
    manager,
    resolvePrompt,
    rejectPrompt,
    emitUpdate,
  };
}

describe("AcpSessionManager — terminal persistence", () => {
  beforeEach(() => {
    clearHistory();
  });

  test("persists a row with the buffered event log on completion and drops the buffer", async () => {
    const id = "session-complete-1";
    const handles = buildSessionWithFakeProcess({
      id,
      agentId: "agent-X",
      protocolSessionId: "proto-X",
      parentConversationId: "conv-1",
    });

    // Emit a few wire-shaped updates before the prompt resolves.
    handles.emitUpdate({
      type: "acp_session_update",
      acpSessionId: id,
      updateType: "agent_message_chunk",
      content: "hello",
    });
    handles.emitUpdate({
      type: "acp_session_update",
      acpSessionId: id,
      updateType: "tool_call",
      toolCallId: "tc-1",
      toolTitle: "Read file",
      toolKind: "read",
      toolStatus: "running",
      locations: [
        { path: "/repo/src/main.ts", line: 7 },
        { path: "/repo/README.md" },
      ],
    });
    handles.emitUpdate({
      type: "acp_session_update",
      acpSessionId: id,
      updateType: "tool_call_update",
      toolCallId: "tc-1",
      toolStatus: "completed",
    });

    // Drive completion. Yield twice to flush the .then() and the
    // subsequent persist call queued behind it.
    handles.resolvePrompt({ stopReason: "end_turn" });
    await Promise.resolve();
    await Promise.resolve();

    const row = readHistoryRow(id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("completed");
    expect(row!.stop_reason).toBe("end_turn");
    expect(row!.agent_id).toBe("agent-X");
    expect(row!.acp_session_id).toBe("proto-X");
    expect(row!.parent_conversation_id).toBe("conv-1");
    expect(row!.completed_at).not.toBeNull();
    expect(row!.error).toBeNull();

    const log = JSON.parse(row!.event_log_json) as AcpSessionUpdate[];
    expect(log).toHaveLength(3);
    expect(log[0]).toMatchObject({
      type: "acp_session_update",
      acpSessionId: id,
      updateType: "agent_message_chunk",
      content: "hello",
    });
    expect(log[1]).toMatchObject({
      updateType: "tool_call",
      toolCallId: "tc-1",
    });
    // locations[] survives persistence so the route round-trips it for
    // history rehydration (the live SSE path already forwards it).
    expect(log[1]!.locations).toEqual([
      { path: "/repo/src/main.ts", line: 7 },
      { path: "/repo/README.md" },
    ]);
    expect(log[2]).toMatchObject({
      updateType: "tool_call_update",
      toolCallId: "tc-1",
      toolStatus: "completed",
    });

    // Buffer entry is dropped after persistence.
    const eventBuffers = (
      handles.manager as unknown as { eventBuffers: Map<string, unknown[]> }
    ).eventBuffers;
    expect(eventBuffers.has(id)).toBe(false);
  });

  test("persists tool_call rawInput/rawOutput verbatim through the event log", async () => {
    const id = "session-raw-io-1";
    const handles = buildSessionWithFakeProcess({
      id,
      agentId: "agent-raw",
      protocolSessionId: "proto-raw",
      parentConversationId: "conv-raw",
    });

    const rawInput = { command: "ls -la", args: ["-la"] };
    const rawOutput = "total 0\ndrwxr-xr-x  2 user  staff  64 .";

    handles.emitUpdate({
      type: "acp_session_update",
      acpSessionId: id,
      updateType: "tool_call",
      toolCallId: "tc-raw",
      toolTitle: "Run command",
      toolKind: "execute",
      toolStatus: "running",
      rawInput,
    });
    handles.emitUpdate({
      type: "acp_session_update",
      acpSessionId: id,
      updateType: "tool_call_update",
      toolCallId: "tc-raw",
      toolStatus: "completed",
      rawOutput,
    });

    handles.resolvePrompt({ stopReason: "end_turn" });
    await Promise.resolve();
    await Promise.resolve();

    const row = readHistoryRow(id);
    expect(row).not.toBeNull();
    const log = JSON.parse(row!.event_log_json) as AcpSessionUpdate[];
    expect(log).toHaveLength(2);
    expect(log[0]!.rawInput).toEqual(rawInput);
    expect(log[1]!.rawOutput).toBe(rawOutput);
  });

  test("persists status='failed' with the error message on prompt rejection", async () => {
    const id = "session-failed-1";
    const handles = buildSessionWithFakeProcess({
      id,
      agentId: "agent-Y",
      protocolSessionId: "proto-Y",
      parentConversationId: "conv-2",
    });

    handles.emitUpdate({
      type: "acp_session_update",
      acpSessionId: id,
      updateType: "agent_message_chunk",
      content: "before crash",
    });

    handles.rejectPrompt(new Error("agent died"));
    await Promise.resolve();
    await Promise.resolve();

    const row = readHistoryRow(id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("failed");
    expect(row!.error).toBe("agent died");
    expect(row!.stop_reason).toBeNull();

    const log = JSON.parse(row!.event_log_json) as AcpSessionUpdate[];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      updateType: "agent_message_chunk",
      content: "before crash",
    });
  });

  test("buffer caps event count at 200 — 300 emitted events => 200 persisted", async () => {
    const id = "session-cap-1";
    const handles = buildSessionWithFakeProcess({
      id,
      agentId: "agent-Z",
      protocolSessionId: "proto-Z",
      parentConversationId: "conv-3",
    });

    for (let i = 0; i < 300; i++) {
      handles.emitUpdate({
        type: "acp_session_update",
        acpSessionId: id,
        updateType: "agent_message_chunk",
        content: `chunk-${i}`,
      });
    }

    // Verify in-memory buffer is bounded before persistence.
    const eventBuffers = (
      handles.manager as unknown as {
        eventBuffers: Map<string, { update: AcpSessionUpdate }[]>;
      }
    ).eventBuffers;
    expect(eventBuffers.get(id)?.length).toBe(200);

    handles.resolvePrompt({ stopReason: "end_turn" });
    await Promise.resolve();
    await Promise.resolve();

    const row = readHistoryRow(id);
    expect(row).not.toBeNull();
    const log = JSON.parse(row!.event_log_json) as AcpSessionUpdate[];
    expect(log).toHaveLength(200);
    // Oldest events were evicted — the persisted log contains the last 200.
    expect((log[0] as { content?: string }).content).toBe("chunk-100");
    expect((log[199] as { content?: string }).content).toBe("chunk-299");
  });

  test("buffer caps aggregate JSON size at 256 KB", async () => {
    const id = "session-bytes-1";
    const handles = buildSessionWithFakeProcess({
      id,
      agentId: "agent-B",
      protocolSessionId: "proto-B",
      parentConversationId: "conv-bytes",
    });

    // Each event is ~5 KB of payload — 80 events => ~400 KB, well past the
    // 256 KB byte cap. Persisted log should be smaller than 80.
    const heavyPayload = "x".repeat(5000);
    for (let i = 0; i < 80; i++) {
      handles.emitUpdate({
        type: "acp_session_update",
        acpSessionId: id,
        updateType: "agent_message_chunk",
        content: heavyPayload,
      });
    }

    handles.resolvePrompt({ stopReason: "end_turn" });
    await Promise.resolve();
    await Promise.resolve();

    const row = readHistoryRow(id);
    expect(row).not.toBeNull();
    const log = JSON.parse(row!.event_log_json) as AcpSessionUpdate[];
    expect(log.length).toBeLessThan(80);
    expect(log.length).toBeGreaterThan(0);
    // Persisted JSON must respect the 256 KB cap (allowing a small margin
    // for the surrounding `[…]` and inter-element commas).
    expect(row!.event_log_json.length).toBeLessThan(256 * 1024 + 1024);
  });

  test("persists the spawn cwd on terminal transition", async () => {
    const id = "session-cwd-1";
    const handles = buildSessionWithFakeProcess({
      id,
      agentId: "agent-cwd",
      protocolSessionId: "proto-cwd",
      parentConversationId: "conv-cwd",
      cwd: "/Users/me/projects/widget",
    });

    handles.resolvePrompt({ stopReason: "end_turn" });
    await Promise.resolve();
    await Promise.resolve();

    const row = readHistoryRow(id);
    expect(row).not.toBeNull();
    expect(row!.cwd).toBe("/Users/me/projects/widget");
  });

  test("persists task, parentToolUseId, and the latest usage snapshot on terminal transition", async () => {
    const id = "session-usage-1";
    const handles = buildSessionWithFakeProcess({
      id,
      agentId: "agent-usage",
      protocolSessionId: "proto-usage",
      parentConversationId: "conv-usage",
      task: "Summarize the report",
      parentToolUseId: "tool-use-123",
      latestUsage: {
        usedTokens: 4200,
        contextSize: 200_000,
        costAmount: 0.0123,
        costCurrency: "USD",
      },
    });

    handles.resolvePrompt({ stopReason: "end_turn" });
    await Promise.resolve();
    await Promise.resolve();

    const row = readHistoryRow(id);
    expect(row).not.toBeNull();
    expect(row!.task).toBe("Summarize the report");
    expect(row!.parent_tool_use_id).toBe("tool-use-123");
    expect(row!.used_tokens).toBe(4200);
    expect(row!.context_size).toBe(200_000);
    expect(row!.cost_amount).toBe(0.0123);
    expect(row!.cost_currency).toBe("USD");
  });

  test("persists NULL usage columns when latestUsage is undefined", async () => {
    const id = "session-no-usage-1";
    const handles = buildSessionWithFakeProcess({
      id,
      agentId: "agent-no-usage",
      protocolSessionId: "proto-no-usage",
      parentConversationId: "conv-no-usage",
      task: "Do work without usage",
    });

    handles.resolvePrompt({ stopReason: "end_turn" });
    await Promise.resolve();
    await Promise.resolve();

    const row = readHistoryRow(id);
    expect(row).not.toBeNull();
    expect(row!.task).toBe("Do work without usage");
    expect(row!.parent_tool_use_id).toBeNull();
    expect(row!.used_tokens).toBeNull();
    expect(row!.context_size).toBeNull();
    expect(row!.cost_amount).toBeNull();
    expect(row!.cost_currency).toBeNull();
    expect(row!.input_tokens).toBeNull();
    expect(row!.output_tokens).toBeNull();
  });

  test("emits acp_session_usage and persists input/output tokens from PromptResponse.usage", async () => {
    const id = "session-io-usage-1";
    const sent: ServerMessage[] = [];
    const handles = buildSessionWithFakeProcess({
      id,
      agentId: "agent-io",
      protocolSessionId: "proto-io",
      parentConversationId: "conv-io",
      // A prior usage_update established the context-window gauge; the prompt
      // response only adds cumulative input/output token totals.
      latestUsage: { usedTokens: 1200, contextSize: 200_000 },
    });

    // Capture the usage event emitted at turn end.
    const captureSend = (
      handles.manager as unknown as {
        sessions: Map<string, { sendToVellum: (m: ServerMessage) => void }>;
      }
    ).sessions.get(id);
    const originalSend = captureSend!.sendToVellum;
    captureSend!.sendToVellum = (msg: ServerMessage) => {
      sent.push(msg);
      originalSend(msg);
    };

    handles.resolvePrompt({
      stopReason: "end_turn",
      usage: { inputTokens: 5000, outputTokens: 800 },
    });
    await Promise.resolve();
    await Promise.resolve();

    const usageEvent = sent.find((m) => m.type === "acp_session_usage");
    expect(usageEvent).toMatchObject({
      type: "acp_session_usage",
      acpSessionId: id,
      inputTokens: 5000,
      outputTokens: 800,
      usedTokens: 1200,
      contextSize: 200_000,
    });

    const row = readHistoryRow(id);
    expect(row).not.toBeNull();
    expect(row!.input_tokens).toBe(5000);
    expect(row!.output_tokens).toBe(800);
    // Context-window gauge from the prior usage_update is preserved.
    expect(row!.used_tokens).toBe(1200);
    expect(row!.context_size).toBe(200_000);
  });

  test("does not emit usage or write token columns when PromptResponse carries no usage", async () => {
    const id = "session-io-no-usage-1";
    const sent: ServerMessage[] = [];
    const handles = buildSessionWithFakeProcess({
      id,
      agentId: "agent-io-none",
      protocolSessionId: "proto-io-none",
      parentConversationId: "conv-io-none",
    });

    const entry = (
      handles.manager as unknown as {
        sessions: Map<string, { sendToVellum: (m: ServerMessage) => void }>;
      }
    ).sessions.get(id);
    const originalSend = entry!.sendToVellum;
    entry!.sendToVellum = (msg: ServerMessage) => {
      sent.push(msg);
      originalSend(msg);
    };

    handles.resolvePrompt({ stopReason: "end_turn" });
    await Promise.resolve();
    await Promise.resolve();

    expect(sent.find((m) => m.type === "acp_session_usage")).toBeUndefined();

    const row = readHistoryRow(id);
    expect(row).not.toBeNull();
    expect(row!.input_tokens).toBeNull();
    expect(row!.output_tokens).toBeNull();
  });

  test("legacy rows without a cwd read back as null", () => {
    insertHistoryRow({
      id: "legacy-row-1",
      agentId: "agent-legacy",
      acpSessionId: "proto-legacy",
      parentConversationId: "conv-legacy",
      startedAt: 1000,
      completedAt: null,
      status: "completed",
      stopReason: null,
      cwd: null,
    });

    const row = readHistoryRow("legacy-row-1");
    expect(row).not.toBeNull();
    expect(row!.cwd).toBeNull();
  });

  test("upserts over a pre-existing row with the same id (resumed runs)", async () => {
    const id = "session-upsert-1";
    // Simulate the row left behind by the original run that a resumed run
    // reuses the id of.
    insertHistoryRow({
      id,
      agentId: "agent-up",
      acpSessionId: "proto-up",
      parentConversationId: "conv-up",
      startedAt: 1000,
      completedAt: 2000,
      status: "cancelled",
      stopReason: "daemon_restarted",
      eventLogJson: '[{"old":true}]',
      cwd: "/old/cwd",
    });

    const handles = buildSessionWithFakeProcess({
      id,
      agentId: "agent-up",
      protocolSessionId: "proto-up",
      parentConversationId: "conv-up",
      cwd: "/new/cwd",
    });

    handles.emitUpdate({
      type: "acp_session_update",
      acpSessionId: id,
      updateType: "agent_message_chunk",
      content: "from the resumed run",
    });

    handles.resolvePrompt({ stopReason: "end_turn" });
    await Promise.resolve();
    await Promise.resolve();

    const count = getSqlite()
      .query(`SELECT COUNT(*) AS n FROM acp_session_history WHERE id = ?`)
      .get(id) as { n: number };
    expect(count.n).toBe(1);

    const row = readHistoryRow(id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("completed");
    expect(row!.stop_reason).toBe("end_turn");
    expect(row!.cwd).toBe("/new/cwd");
    const log = JSON.parse(row!.event_log_json) as AcpSessionUpdate[];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ content: "from the resumed run" });
  });

  test("persists empty event log when no updates were emitted", async () => {
    const id = "session-empty-1";
    const handles = buildSessionWithFakeProcess({
      id,
      agentId: "agent-empty",
      protocolSessionId: "proto-empty",
      parentConversationId: "conv-empty",
    });

    handles.resolvePrompt({ stopReason: "end_turn" });
    await Promise.resolve();
    await Promise.resolve();

    const row = readHistoryRow(id);
    expect(row).not.toBeNull();
    expect(row!.event_log_json).toBe("[]");
    expect(row!.status).toBe("completed");
  });
});
