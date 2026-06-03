import { describe, expect, it } from "bun:test";
import type { ConversationContentBlock } from "@vellumai/assistant-api";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type {
  DisplayMessage,
  Surface,
} from "@/domains/chat/types/types";
import {
  deriveContentBlocks,
  groupContentBlocks,
  mapWireContentBlocks,
  resolveContentBlocks,
} from "@/domains/chat/utils/display-content-blocks";

function toolCall(id: string, toolName = "do_thing"): ChatMessageToolCall {
  return { id, toolName, input: {}, status: "completed" };
}

function surface(surfaceId: string): Surface {
  return { surfaceId, surfaceType: "card", data: {} };
}

function makeMessage(partial: Partial<DisplayMessage>): DisplayMessage {
  return { id: "m1", role: "assistant", ...partial };
}

describe("deriveContentBlocks", () => {
  it("walks contentOrder resolving text/thinking/tool/surface in order", () => {
    const message = makeMessage({
      textSegments: ["hello", "world"],
      thinkingSegments: ["pondering"],
      toolCalls: [toolCall("tc-1")],
      surfaces: [surface("sf-1")],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "thinking", id: "0" },
        { type: "toolCall", id: "tc-1" },
        { type: "surface", id: "sf-1" },
        { type: "text", id: "1" },
      ],
    });

    expect(deriveContentBlocks(message)).toEqual([
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "pondering" },
      { type: "tool_use", toolCall: toolCall("tc-1") },
      { type: "surface", surface: surface("sf-1") },
      { type: "text", text: "world" },
    ]);
  });

  it("resolves surfaces and tool calls referenced by positional index", () => {
    const message = makeMessage({
      toolCalls: [toolCall("tc-a"), toolCall("tc-b")],
      surfaces: [surface("sf-a")],
      contentOrder: [
        { type: "tool", id: "1" },
        { type: "surface", id: "0" },
      ],
    });

    expect(deriveContentBlocks(message)).toEqual([
      { type: "tool_use", toolCall: toolCall("tc-b") },
      { type: "surface", surface: surface("sf-a") },
    ]);
  });

  it("skips entries whose referenced content is missing", () => {
    const message = makeMessage({
      textSegments: ["only"],
      toolCalls: [],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "text", id: "5" },
        { type: "toolCall", id: "missing" },
      ],
    });

    expect(deriveContentBlocks(message)).toEqual([
      { type: "text", text: "only" },
    ]);
  });

  it("does not append surfaces absent from contentOrder", () => {
    const message = makeMessage({
      textSegments: ["body"],
      surfaces: [surface("sf-1"), surface("sf-2")],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "surface", id: "sf-1" },
      ],
    });

    expect(deriveContentBlocks(message)).toEqual([
      { type: "text", text: "body" },
      { type: "surface", surface: surface("sf-1") },
    ]);
  });

  it("preserves empty-string text blocks but drops undefined segments", () => {
    const message = makeMessage({
      textSegments: ["", "kept"],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "text", id: "1" },
      ],
    });

    expect(deriveContentBlocks(message)).toEqual([
      { type: "text", text: "" },
      { type: "text", text: "kept" },
    ]);
  });
});

describe("mapWireContentBlocks", () => {
  it("maps wire blocks, enriching tool_use by ordinal and surface by id", () => {
    const wire: ConversationContentBlock[] = [
      { type: "text", text: "hi" },
      { type: "tool_use", toolCall: { name: "do_thing", input: {} } },
      { type: "thinking", thinking: "hmm" },
      {
        type: "surface",
        surface: { surfaceId: "sf-1", surfaceType: "card", data: {} },
      },
    ];
    const displayToolCalls = [toolCall("tc-1")];
    const displaySurfaces = [surface("sf-1")];

    expect(
      mapWireContentBlocks(wire, displayToolCalls, displaySurfaces),
    ).toEqual([
      { type: "text", text: "hi" },
      { type: "tool_use", toolCall: toolCall("tc-1") },
      { type: "thinking", thinking: "hmm" },
      { type: "surface", surface: surface("sf-1") },
    ]);
  });

  it("maps consecutive tool_use blocks to display tool calls in order", () => {
    const wire: ConversationContentBlock[] = [
      { type: "tool_use", toolCall: { name: "a", input: {} } },
      { type: "tool_use", toolCall: { name: "b", input: {} } },
    ];
    const displayToolCalls = [toolCall("tc-1", "a"), toolCall("tc-2", "b")];

    expect(mapWireContentBlocks(wire, displayToolCalls, [])).toEqual([
      { type: "tool_use", toolCall: toolCall("tc-1", "a") },
      { type: "tool_use", toolCall: toolCall("tc-2", "b") },
    ]);
  });

  it("drops attachment blocks", () => {
    const wire: ConversationContentBlock[] = [
      { type: "text", text: "a" },
      {
        type: "attachment",
        attachment: {
          id: "att-1",
          filename: "f.txt",
          mimeType: "text/plain",
          sizeBytes: 12,
          kind: "file",
        },
      },
    ];

    expect(mapWireContentBlocks(wire, [], [])).toEqual([
      { type: "text", text: "a" },
    ]);
  });
});

describe("resolveContentBlocks", () => {
  it("enriches the wire projection against the row's live arrays when present", () => {
    const message = makeMessage({
      contentBlocks: [
        { type: "text", text: "from blocks" },
        { type: "tool_use", toolCall: { name: "do_thing", input: {} } },
        {
          type: "surface",
          surface: { surfaceId: "sf-1", surfaceType: "card", data: {} },
        },
      ],
      toolCalls: [toolCall("tc-1")],
      surfaces: [surface("sf-1")],
      textSegments: ["from legacy"],
      contentOrder: [{ type: "text", id: "0" }],
    });

    expect(resolveContentBlocks(message)).toEqual([
      { type: "text", text: "from blocks" },
      { type: "tool_use", toolCall: toolCall("tc-1") },
      { type: "surface", surface: surface("sf-1") },
    ]);
  });

  it("reflects live patches to surfaces/toolCalls without re-projecting the wire blocks", () => {
    const wire: ConversationContentBlock[] = [
      { type: "tool_use", toolCall: { name: "do_thing", input: {} } },
      {
        type: "surface",
        surface: { surfaceId: "sf-1", surfaceType: "card", data: {} },
      },
    ];
    // GIVEN a history row whose surface has since been completed and whose tool
    // call has since errored — patched in place on the row's display arrays.
    const message = makeMessage({
      contentBlocks: wire,
      toolCalls: [{ ...toolCall("tc-1"), status: "error" }],
      surfaces: [{ ...surface("sf-1"), completed: true }],
    });

    // WHEN the renderer resolves the row's blocks
    // THEN the enriched blocks carry the patched state, not a stale snapshot.
    expect(resolveContentBlocks(message)).toEqual([
      { type: "tool_use", toolCall: { ...toolCall("tc-1"), status: "error" } },
      { type: "surface", surface: { ...surface("sf-1"), completed: true } },
    ]);
  });

  it("drops a wire surface block once the surface is removed from the row", () => {
    const message = makeMessage({
      contentBlocks: [
        { type: "text", text: "body" },
        {
          type: "surface",
          surface: { surfaceId: "sf-1", surfaceType: "card", data: {} },
        },
      ],
      surfaces: [],
    });

    expect(resolveContentBlocks(message)).toEqual([
      { type: "text", text: "body" },
    ]);
  });

  it("falls back to deriving from positional arrays", () => {
    const message = makeMessage({
      textSegments: ["from legacy"],
      contentOrder: [{ type: "text", id: "0" }],
    });

    expect(resolveContentBlocks(message)).toEqual([
      { type: "text", text: "from legacy" },
    ]);
  });

  it("wire-mapped and legacy-derived blocks agree for the same content", () => {
    const wire: ConversationContentBlock[] = [
      { type: "text", text: "intro" },
      { type: "tool_use", toolCall: { name: "do_thing", input: {} } },
      {
        type: "surface",
        surface: { surfaceId: "sf-1", surfaceType: "card", data: {} },
      },
      { type: "text", text: "outro" },
    ];
    const toolCalls = [toolCall("tc-1")];
    const surfaces = [surface("sf-1")];

    const fromWire = mapWireContentBlocks(wire, toolCalls, surfaces);
    const fromLegacy = deriveContentBlocks(
      makeMessage({
        textSegments: ["intro", "outro"],
        toolCalls,
        surfaces,
        contentOrder: [
          { type: "text", id: "0" },
          { type: "toolCall", id: "tc-1" },
          { type: "surface", id: "sf-1" },
          { type: "text", id: "1" },
        ],
      }),
    );

    expect(fromWire).toEqual(fromLegacy);
  });
});

describe("groupContentBlocks", () => {
  it("merges adjacent tool_use and thinking blocks, keeping order", () => {
    const groups = groupContentBlocks([
      { type: "thinking", thinking: "step one" },
      { type: "thinking", thinking: "step two" },
      { type: "text", text: "intro" },
      { type: "tool_use", toolCall: toolCall("a") },
      { type: "tool_use", toolCall: toolCall("b") },
      { type: "surface", surface: surface("sf-1") },
    ]);

    expect(groups).toEqual([
      { type: "thinking", thinking: "step one\nstep two", index: 0 },
      { type: "text", text: "intro", index: 2 },
      { type: "toolCalls", toolCalls: [toolCall("a"), toolCall("b")], index: 3 },
      { type: "surface", surface: surface("sf-1"), index: 5 },
    ]);
  });

  it("splits non-adjacent tool_use blocks into separate groups", () => {
    const groups = groupContentBlocks([
      { type: "tool_use", toolCall: toolCall("a") },
      { type: "text", text: "between" },
      { type: "tool_use", toolCall: toolCall("b") },
    ]);

    expect(groups.map((g) => g.type)).toEqual([
      "toolCalls",
      "text",
      "toolCalls",
    ]);
  });
});
