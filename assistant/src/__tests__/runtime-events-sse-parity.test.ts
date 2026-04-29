/**
 * HTTP parity tests for the SSE assistant-events endpoint.
 *
 * Asserts that every streaming/delta ServerMessage type is preserved
 * exactly — field-for-field — when delivered through the SSE route.
 *
 * Message types covered:
 *   - assistant_text_delta
 *   - assistant_thinking_delta
 *   - tool_input_delta
 *   - tool_output_chunk
 *   - tool_result
 *   - message_request_complete (request-level terminal)
 *   - message_complete   (terminal)
 *   - generation_handoff (terminal)
 *   - generation_cancelled (terminal)
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import type { ServerMessage } from "../daemon/message-protocol.js";
import { getOrCreateConversation } from "../memory/conversation-key-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";

initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Subscribe to the SSE endpoint for a given conversationKey, publish one
 * event, read the first SSE frame, and return the parsed AssistantEvent.
 *
 * Uses handleSubscribeAssistantEvents directly (bypassing HTTP) to avoid
 * chunked-transfer buffering in Bun's loopback implementation.
 */
async function publishAndReadFrame(
  conversationKey: string,
  message: ServerMessage,
): Promise<AssistantEvent> {
  const { conversationId } = getOrCreateConversation(conversationKey);

  const ac = new AbortController();

  const { handleSubscribeAssistantEvents } =
    await import("../runtime/routes/events-routes.js");
  const stream = handleSubscribeAssistantEvents({
    queryParams: { conversationKey },
    abortSignal: ac.signal,
  });

  const event = buildAssistantEvent(message, conversationId);
  await assistantEventHub.publish(event);

  const reader = stream.getReader();

  // The first chunk is the immediate heartbeat comment enqueued in start().
  await reader.read();

  // The second chunk is the actual assistant event.
  const { value } = await reader.read();
  ac.abort();

  const frame = new TextDecoder().decode(value);
  // SSE frame: "event: assistant_event\nid: <id>\ndata: <json>\n\n"
  const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`No data line in SSE frame:\n${frame}`);
  return JSON.parse(dataLine.slice("data: ".length)) as AssistantEvent;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSE HTTP parity — streaming/delta message types", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM conversation_keys");
    db.run("DELETE FROM conversations");
  });

  // ── assistant_text_delta ─────────────────────────────────────────────────

  test("preserves assistant_text_delta payload", async () => {
    const msg = {
      type: "assistant_text_delta" as const,
      text: "Hello, world!",
      conversationId: "conv-text-delta",
    };
    const event = await publishAndReadFrame("parity-text-delta", msg);

    expect(event.message.type).toBe("assistant_text_delta");
    const m = event.message as typeof msg;
    expect(m.text).toBe("Hello, world!");
    expect(m.conversationId).toBe("conv-text-delta");
  });

  test("preserves assistant_text_delta without optional conversationId", async () => {
    const msg = {
      type: "assistant_text_delta" as const,
      text: "No session here",
    };
    const event = await publishAndReadFrame("parity-text-delta-nosession", msg);

    const m = event.message as typeof msg;
    expect(m.type).toBe("assistant_text_delta");
    expect(m.text).toBe("No session here");
    expect((m as Record<string, unknown>).conversationId).toBeUndefined();
  });

  // ── assistant_thinking_delta ─────────────────────────────────────────────

  test("preserves assistant_thinking_delta payload", async () => {
    const msg = {
      type: "assistant_thinking_delta" as const,
      thinking: "Let me reason through this...",
      conversationId: "conv-thinking-test",
    };
    const event = await publishAndReadFrame("parity-thinking-delta", msg);

    expect(event.message.type).toBe("assistant_thinking_delta");
    const m = event.message as typeof msg;
    expect(m.thinking).toBe("Let me reason through this...");
    expect(m.conversationId).toBe("conv-thinking-test");
  });

  // ── tool_input_delta ─────────────────────────────────────────────────────

  test("preserves tool_input_delta payload", async () => {
    const msg = {
      type: "tool_input_delta" as const,
      toolName: "bash",
      content: '{"command": "ls -la"}',
      conversationId: "conv-tool-input",
    };
    const event = await publishAndReadFrame("parity-tool-input-delta", msg);

    expect(event.message.type).toBe("tool_input_delta");
    const m = event.message as typeof msg;
    expect(m.toolName).toBe("bash");
    expect(m.content).toBe('{"command": "ls -la"}');
    expect(m.conversationId).toBe("conv-tool-input");
  });

  // ── tool_output_chunk ────────────────────────────────────────────────────

  test("preserves tool_output_chunk payload", async () => {
    const msg = {
      type: "tool_output_chunk" as const,
      chunk: "total 42\n-rw-r--r-- 1 user group 1234 Jan 1 00:00 file.ts",
      conversationId: "conv-tool-output",
      subType: "tool_complete" as const,
      subToolName: "bash",
      subToolInput: "ls -la",
      subToolIsError: false,
      subToolId: "tool-abc-123",
    };
    const event = await publishAndReadFrame("parity-tool-output-chunk", msg);

    expect(event.message.type).toBe("tool_output_chunk");
    const m = event.message as typeof msg;
    expect(m.chunk).toBe(msg.chunk);
    expect(m.conversationId).toBe("conv-tool-output");
    expect(m.subType).toBe("tool_complete");
    expect(m.subToolName).toBe("bash");
    expect(m.subToolInput).toBe("ls -la");
    expect(m.subToolIsError).toBe(false);
    expect(m.subToolId).toBe("tool-abc-123");
  });

  test("preserves minimal tool_output_chunk (chunk only)", async () => {
    const msg = {
      type: "tool_output_chunk" as const,
      chunk: "stdout line 1\n",
    };
    const event = await publishAndReadFrame(
      "parity-tool-output-chunk-minimal",
      msg,
    );

    const m = event.message as typeof msg;
    expect(m.type).toBe("tool_output_chunk");
    expect(m.chunk).toBe("stdout line 1\n");
  });

  // ── tool_result ──────────────────────────────────────────────────────────

  test("preserves tool_result payload", async () => {
    const msg = {
      type: "tool_result" as const,
      toolName: "read_file",
      result: "File contents here",
      isError: false,
      conversationId: "conv-tool-result",
      status: "success",
    };
    const event = await publishAndReadFrame("parity-tool-result", msg);

    expect(event.message.type).toBe("tool_result");
    const m = event.message as typeof msg;
    expect(m.toolName).toBe("read_file");
    expect(m.result).toBe("File contents here");
    expect(m.isError).toBe(false);
    expect(m.conversationId).toBe("conv-tool-result");
    expect(m.status).toBe("success");
  });

  test("preserves tool_result with error flag", async () => {
    const msg = {
      type: "tool_result" as const,
      toolName: "bash",
      result: "Command not found: foobar",
      isError: true,
    };
    const event = await publishAndReadFrame("parity-tool-result-error", msg);

    const m = event.message as typeof msg;
    expect(m.type).toBe("tool_result");
    expect(m.isError).toBe(true);
    expect(m.result).toBe("Command not found: foobar");
  });

  // ── message_complete (terminal) ──────────────────────────────────────────

  test("preserves message_complete payload", async () => {
    const msg = {
      type: "message_complete" as const,
      conversationId: "conv-msg-complete",
    };
    const event = await publishAndReadFrame("parity-message-complete", msg);

    expect(event.message.type).toBe("message_complete");
    const m = event.message as typeof msg;
    expect(m.conversationId).toBe("conv-msg-complete");
  });

  test("preserves message_complete without conversationId", async () => {
    const msg = { type: "message_complete" as const };
    const event = await publishAndReadFrame(
      "parity-message-complete-nosession",
      msg,
    );

    expect(event.message.type).toBe("message_complete");
  });

  // ── message_request_complete (request-level terminal) ───────────────────

  test("preserves message_request_complete payload", async () => {
    const msg = {
      type: "message_request_complete" as const,
      conversationId: "conv-msg-request-complete",
      requestId: "req-123",
      runStillActive: true,
    };
    const event = await publishAndReadFrame(
      "parity-message-request-complete",
      msg,
    );

    expect(event.message.type).toBe("message_request_complete");
    const m = event.message as typeof msg;
    expect(m.conversationId).toBe("conv-msg-request-complete");
    expect(m.requestId).toBe("req-123");
    expect(m.runStillActive).toBe(true);
  });

  // ── generation_handoff (terminal) ────────────────────────────────────────

  test("preserves generation_handoff payload", async () => {
    const msg = {
      type: "generation_handoff" as const,
      conversationId: "conv-handoff",
      requestId: "req-xyz-789",
      queuedCount: 2,
    };
    const event = await publishAndReadFrame("parity-generation-handoff", msg);

    expect(event.message.type).toBe("generation_handoff");
    const m = event.message as typeof msg;
    expect(m.conversationId).toBe("conv-handoff");
    expect(m.requestId).toBe("req-xyz-789");
    expect(m.queuedCount).toBe(2);
  });

  // ── generation_cancelled (terminal) ─────────────────────────────────────

  test("preserves generation_cancelled payload", async () => {
    const msg = {
      type: "generation_cancelled" as const,
      conversationId: "conv-cancelled",
    };
    const event = await publishAndReadFrame("parity-generation-cancelled", msg);

    expect(event.message.type).toBe("generation_cancelled");
    const m = event.message as typeof msg;
    expect(m.conversationId).toBe("conv-cancelled");
  });

  // ── Envelope integrity ───────────────────────────────────────────────────

  test("SSE envelope preserves conversationId across all event types", async () => {
    const conversationKey = "parity-envelope-check";
    const { conversationId } = getOrCreateConversation(conversationKey);

    const ac = new AbortController();
    const { handleSubscribeAssistantEvents } =
      await import("../runtime/routes/events-routes.js");
    const stream = handleSubscribeAssistantEvents({
      queryParams: { conversationKey },
      abortSignal: ac.signal,
    });

    const msg: ServerMessage = {
      type: "assistant_text_delta" as const,
      text: "envelope test",
    };
    const published = buildAssistantEvent(msg, conversationId);
    await assistantEventHub.publish(published);

    const reader = stream.getReader();

    // The first chunk is the immediate heartbeat comment enqueued in start().
    await reader.read();

    // The second chunk is the actual assistant event.
    const { value } = await reader.read();
    ac.abort();

    const frame = new TextDecoder().decode(value);
    const dataLine = frame.split("\n").find((l) => l.startsWith("data: "))!;
    const received = JSON.parse(
      dataLine.slice("data: ".length),
    ) as AssistantEvent;

    // Envelope fields
    expect(received.id).toBe(published.id);
    expect(received.conversationId).toBe(conversationId);
    expect(received.emittedAt).toBe(published.emittedAt);
    // SSE frame fields
    expect(frame).toContain("event: assistant_event");
    expect(frame).toContain(`id: ${published.id}`);
  });
});
