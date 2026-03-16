import { describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../runtime/assistant-event.js";
import {
  formatSseFrame,
  formatSseHeartbeat,
} from "../runtime/assistant-event.js";

// ── Type / shape tests ────────────────────────────────────────────────────────

describe("AssistantEvent shape", () => {
  test("accepts a minimal valid event", () => {
    const event: AssistantEvent = {
      id: "evt_001",
      assistantId: "ast_123",
      emittedAt: "2026-02-18T21:20:00.000Z",
      message: {
        type: "assistant_text_delta",
        conversationId: "conv_456",
        text: "Working on it...",
      },
    };

    expect(event.id).toBe("evt_001");
    expect(event.assistantId).toBe("ast_123");
    expect(event.conversationId).toBeUndefined();
    expect(event.emittedAt).toBe("2026-02-18T21:20:00.000Z");
    expect(event.message.type).toBe("assistant_text_delta");
  });

  test("accepts a full event with conversationId", () => {
    const event: AssistantEvent = {
      id: "evt_002",
      assistantId: "ast_123",
      conversationId: "conv_456",
      emittedAt: "2026-02-18T21:20:00.000Z",
      message: {
        type: "message_complete",
        conversationId: "conv_456",
      },
    };

    expect(event.conversationId).toBe("conv_456");
    expect(event.message.type).toBe("message_complete");
  });
});

// ── SSE framing tests ─────────────────────────────────────────────────────────

describe("formatSseFrame", () => {
  const baseEvent: AssistantEvent = {
    id: "evt_003",
    assistantId: "ast_abc",
    conversationId: "sess_xyz",
    emittedAt: "2026-02-18T00:00:00.000Z",
    message: {
      type: "assistant_text_delta",
      conversationId: "sess_xyz",
      text: "hello",
    },
  };

  test("produces event, id, and data lines followed by blank line", () => {
    const frame = formatSseFrame(baseEvent);
    const lines = frame.split("\n");

    expect(lines[0]).toBe("event: assistant_event");
    expect(lines[1]).toBe(`id: ${baseEvent.id}`);
    expect(lines[2]).toStartWith("data: ");
    // Trailing blank line: frame ends with \n\n, so last two entries are '' ''
    expect(lines[lines.length - 1]).toBe("");
    expect(lines[lines.length - 2]).toBe("");
  });

  test("data line contains valid JSON matching the event", () => {
    const frame = formatSseFrame(baseEvent);
    const dataLine = frame.split("\n").find((l) => l.startsWith("data: "))!;
    const parsed = JSON.parse(
      dataLine.slice("data: ".length),
    ) as AssistantEvent;

    expect(parsed.id).toBe(baseEvent.id);
    expect(parsed.assistantId).toBe(baseEvent.assistantId);
    expect(parsed.conversationId).toBe(baseEvent.conversationId);
    expect(parsed.emittedAt).toBe(baseEvent.emittedAt);
    expect(parsed.message.type).toBe("assistant_text_delta");
  });

  test("id line uses the event id verbatim", () => {
    const event: AssistantEvent = { ...baseEvent, id: "unique-evt-id-xyz" };
    const frame = formatSseFrame(event);
    expect(frame).toContain("id: unique-evt-id-xyz\n");
  });

  test("strips newline characters from event.id to prevent SSE frame injection", () => {
    const event: AssistantEvent = {
      ...baseEvent,
      id: 'foo\ndata: {"injected":true}',
    };
    const frame = formatSseFrame(event);
    const lines = frame.split("\n");
    // id line must not contain the injected payload
    const idLine = lines.find((l) => l.startsWith("id: "))!;
    expect(idLine).toBe('id: foodata: {"injected":true}');
    // only one data line must exist
    const dataLines = lines.filter((l) => l.startsWith("data: "));
    expect(dataLines).toHaveLength(1);
  });

  test('event type field is always "assistant_event"', () => {
    const frame = formatSseFrame(baseEvent);
    expect(frame.startsWith("event: assistant_event\n")).toBe(true);
  });

  test("frame ends with double newline", () => {
    const frame = formatSseFrame(baseEvent);
    expect(frame.endsWith("\n\n")).toBe(true);
  });
});

// ── Heartbeat tests ───────────────────────────────────────────────────────────

describe("formatSseHeartbeat", () => {
  test("returns a SSE comment line followed by blank line", () => {
    const hb = formatSseHeartbeat();
    expect(hb).toBe(": heartbeat\n\n");
  });

  test("starts with colon (SSE comment marker)", () => {
    expect(formatSseHeartbeat().startsWith(":")).toBe(true);
  });
});
