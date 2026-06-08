import { describe, expect, it } from "bun:test";

import type { SubagentDetailEvent } from "@vellumai/assistant-api";

import { mapDetailEvents } from "./map-detail-events";

describe("mapDetailEvents", () => {
  it("maps daemon event types to timeline types", () => {
    const raw: SubagentDetailEvent[] = [
      { type: "text", content: "hello" },
      { type: "assistant_text_delta", content: "world" },
      { type: "tool_use", content: "searching", toolName: "web_search" },
      { type: "tool_use_start", content: "reading", toolName: "file_read" },
      { type: "tool_result", content: "found it", toolName: "web_search" },
      { type: "error", content: "oops", isError: true },
    ];
    const events = mapDetailEvents(raw);

    // First two text events coalesce into one.
    expect(events).toHaveLength(5);
    expect(events[0]!.type).toBe("text");
    expect(events[0]!.content).toBe("hello\n\nworld");
    expect(events[1]!.type).toBe("tool_call");
    expect(events[1]!.toolName).toBe("web_search");
    expect(events[2]!.type).toBe("tool_call");
    expect(events[2]!.toolName).toBe("file_read");
    expect(events[3]!.type).toBe("tool_result");
    expect(events[4]!.type).toBe("error");
    expect(events[4]!.isError).toBe(true);
  });

  it("skips unknown event types", () => {
    const raw: SubagentDetailEvent[] = [
      { type: "unknown_future_type", content: "ignored" },
      { type: "text", content: "kept" },
    ];
    const events = mapDetailEvents(raw);

    expect(events).toHaveLength(1);
    expect(events[0]!.content).toBe("kept");
  });

  it("filters empty text events", () => {
    const raw: SubagentDetailEvent[] = [
      { type: "text", content: "" },
      { type: "text", content: "nonempty" },
    ];
    const events = mapDetailEvents(raw);

    expect(events).toHaveLength(1);
    expect(events[0]!.content).toBe("nonempty");
  });

  it("coalesces consecutive text events", () => {
    const raw: SubagentDetailEvent[] = [
      { type: "text", content: "line 1" },
      { type: "text", content: "line 2" },
      { type: "text", content: "line 3" },
    ];
    const events = mapDetailEvents(raw);

    expect(events).toHaveLength(1);
    expect(events[0]!.content).toBe("line 1\n\nline 2\n\nline 3");
  });

  it("does not coalesce text separated by a tool call", () => {
    const raw: SubagentDetailEvent[] = [
      { type: "text", content: "before" },
      { type: "tool_use", content: "searching", toolName: "web_search" },
      { type: "text", content: "after" },
    ];
    const events = mapDetailEvents(raw);

    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe("text");
    expect(events[1]!.type).toBe("tool_call");
    expect(events[2]!.type).toBe("text");
  });

  it("returns empty array for empty input", () => {
    expect(mapDetailEvents([])).toEqual([]);
  });

  it("generates sequential detail-N ids", () => {
    const raw: SubagentDetailEvent[] = [
      { type: "tool_use", content: "a", toolName: "t" },
      { type: "tool_result", content: "b", toolName: "t" },
    ];
    const events = mapDetailEvents(raw);

    expect(events[0]!.id).toBe("detail-1");
    expect(events[1]!.id).toBe("detail-2");
  });
});
