import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "../adapter";
import type { TranscriptTurn } from "../transcript";
import { buildTranscriptView } from "../transcript-view";

function simTurn(content: string, emittedAt: string): TranscriptTurn {
  return { role: "simulator", content, emittedAt };
}

function event(message: AgentEvent["message"], emittedAt?: string): AgentEvent {
  return { message, emittedAt };
}

describe("buildTranscriptView", () => {
  test("GIVEN no assistant events WHEN building THEN persisted turns render as plain messages", () => {
    const turns: TranscriptTurn[] = [
      simTurn("build me a calculator", "2026-01-01T00:00:00Z"),
      {
        role: "assistant",
        content: "Here you go",
        emittedAt: "2026-01-01T00:00:05Z",
      },
    ];

    const items = buildTranscriptView(turns, []);

    expect(items).toEqual([
      {
        role: "simulator",
        content: "build me a calculator",
        emittedAt: "2026-01-01T00:00:00Z",
      },
      {
        role: "assistant",
        emittedAt: "2026-01-01T00:00:05Z",
        blocks: [{ kind: "text", text: "Here you go" }],
      },
    ]);
  });

  test("GIVEN consecutive deltas of one kind WHEN building THEN they coalesce into a single block", () => {
    const items = buildTranscriptView(
      [simTurn("hi", "2026-01-01T00:00:00Z")],
      [
        event(
          { type: "assistant_thinking_delta", thinking: "Let me " },
          "2026-01-01T00:00:01Z",
        ),
        event(
          { type: "assistant_thinking_delta", thinking: "think." },
          "2026-01-01T00:00:02Z",
        ),
        event(
          { type: "assistant_text_delta", text: "Hello " },
          "2026-01-01T00:00:03Z",
        ),
        event(
          { type: "assistant_text_delta", text: "there" },
          "2026-01-01T00:00:04Z",
        ),
      ],
    );

    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({
      role: "assistant",
      emittedAt: "2026-01-01T00:00:01Z",
      blocks: [
        { kind: "thinking", thinking: "Let me think." },
        { kind: "text", text: "Hello there" },
      ],
    });
  });

  test("GIVEN a kind switch and return WHEN building THEN interleaving order is preserved", () => {
    const items = buildTranscriptView(
      [simTurn("hi", "2026-01-01T00:00:00Z")],
      [
        event(
          { type: "assistant_thinking_delta", thinking: "a" },
          "2026-01-01T00:00:01Z",
        ),
        event(
          { type: "assistant_text_delta", text: "b" },
          "2026-01-01T00:00:02Z",
        ),
        event(
          { type: "assistant_thinking_delta", thinking: "c" },
          "2026-01-01T00:00:03Z",
        ),
      ],
    );

    expect(items[1]).toMatchObject({
      blocks: [
        { kind: "thinking", thinking: "a" },
        { kind: "text", text: "b" },
        { kind: "thinking", thinking: "c" },
      ],
    });
  });

  test("GIVEN a tool_use_start and a tool_result without toolUseId WHEN building THEN the oldest running call completes", () => {
    const items = buildTranscriptView(
      [simTurn("hi", "2026-01-01T00:00:00Z")],
      [
        event(
          {
            type: "tool_use_start",
            toolName: "skill_load",
            toolUseId: "tool-1",
            input: { skill: "app-builder" },
          },
          "2026-01-01T00:00:01Z",
        ),
        event(
          { type: "tool_result", toolName: "", result: "Skill loaded" },
          "2026-01-01T00:00:02Z",
        ),
      ],
    );

    expect(items[1]).toMatchObject({
      blocks: [
        {
          kind: "tool_call",
          toolName: "skill_load",
          toolUseId: "tool-1",
          input: { skill: "app-builder" },
          result: "Skill loaded",
          status: "completed",
        },
      ],
    });
  });

  test("GIVEN a tool_result carrying toolUseId WHEN building THEN it completes the matching call, not the oldest", () => {
    const items = buildTranscriptView(
      [simTurn("hi", "2026-01-01T00:00:00Z")],
      [
        event(
          { type: "tool_use_start", toolName: "first", toolUseId: "tool-1" },
          "2026-01-01T00:00:01Z",
        ),
        event(
          { type: "tool_use_start", toolName: "second", toolUseId: "tool-2" },
          "2026-01-01T00:00:02Z",
        ),
        event(
          {
            type: "tool_result",
            toolUseId: "tool-2",
            result: "done",
            isError: true,
          },
          "2026-01-01T00:00:03Z",
        ),
      ],
    );

    expect(items[1]).toMatchObject({
      blocks: [
        { kind: "tool_call", toolName: "first", status: "running" },
        {
          kind: "tool_call",
          toolName: "second",
          status: "completed",
          result: "done",
          isError: true,
        },
      ],
    });
  });

  test("GIVEN a ui_surface_show event WHEN building THEN it renders as a surface block", () => {
    const items = buildTranscriptView(
      [simTurn("hi", "2026-01-01T00:00:00Z")],
      [
        event(
          {
            type: "ui_surface_show",
            surfaceType: "card",
            title: "Response limit reached",
            data: { body: "Continue?" },
          },
          "2026-01-01T00:00:01Z",
        ),
      ],
    );

    expect(items[1]).toMatchObject({
      blocks: [
        {
          kind: "surface",
          surfaceType: "card",
          title: "Response limit reached",
          data: { body: "Continue?" },
        },
      ],
    });
  });

  test("GIVEN a later simulator turn WHEN building THEN it closes the assistant message and opens a new one", () => {
    const items = buildTranscriptView(
      [
        simTurn("first", "2026-01-01T00:00:00Z"),
        simTurn("second", "2026-01-01T00:00:10Z"),
      ],
      [
        event(
          { type: "assistant_text_delta", text: "reply one" },
          "2026-01-01T00:00:01Z",
        ),
        event(
          { type: "assistant_text_delta", text: "reply two" },
          "2026-01-01T00:00:11Z",
        ),
      ],
    );

    expect(items.map((item) => item.role)).toEqual([
      "simulator",
      "assistant",
      "simulator",
      "assistant",
    ]);
    expect(items[1]).toMatchObject({
      blocks: [{ kind: "text", text: "reply one" }],
    });
    expect(items[3]).toMatchObject({
      blocks: [{ kind: "text", text: "reply two" }],
    });
  });

  test("GIVEN untimestamped events WHEN building THEN persisted turns render so turn order is preserved", () => {
    // The Hermes adapter synthesizes message_chunk events with no
    // emittedAt — they can't be ordered against simulator turns.
    const turns: TranscriptTurn[] = [
      simTurn("first", "2026-01-01T00:00:00Z"),
      {
        role: "assistant",
        content: "reply one",
        emittedAt: "2026-01-01T00:00:01Z",
      },
      simTurn("second", "2026-01-01T00:00:10Z"),
      {
        role: "assistant",
        content: "reply two",
        emittedAt: "2026-01-01T00:00:11Z",
      },
    ];

    const items = buildTranscriptView(turns, [
      event({ type: "message_chunk", chunk: "reply one" }),
      event({ type: "message_chunk", chunk: "reply two" }),
    ]);

    expect(items.map((item) => item.role)).toEqual([
      "simulator",
      "assistant",
      "simulator",
      "assistant",
    ]);
    expect(items[1]).toMatchObject({
      blocks: [{ kind: "text", text: "reply one" }],
    });
    expect(items[3]).toMatchObject({
      blocks: [{ kind: "text", text: "reply two" }],
    });
  });

  test("GIVEN plumbing-only events WHEN building THEN no assistant message opens", () => {
    const items = buildTranscriptView(
      [simTurn("hi", "2026-01-01T00:00:00Z")],
      [
        event({ type: "sync_changed", tags: [] }, "2026-01-01T00:00:01Z"),
        event(
          { type: "assistant_activity_state", phase: "thinking" },
          "2026-01-01T00:00:02Z",
        ),
        event(
          { type: "tool_result", result: "orphan" },
          "2026-01-01T00:00:03Z",
        ),
      ],
    );

    expect(items).toEqual([
      { role: "simulator", content: "hi", emittedAt: "2026-01-01T00:00:00Z" },
    ]);
  });
});
