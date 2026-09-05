import { describe, expect, test } from "bun:test";

import {
  stripPointerInjections,
  turnStartUserMessageHasPointer,
} from "../context/strip-injections.js";
import { stripExistingMemoryInjections } from "../plugins/defaults/memory/graph/conversation-graph-memory.js";
import { wrapMemoryPointerBlock } from "../plugins/defaults/memory/memory-marker.js";
import type { ContentBlock, Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// stripExistingMemoryInjections — removes memory-injected blocks from the
// front of the last user message while preserving user-attached content.
// ---------------------------------------------------------------------------

function userMsg(...content: ContentBlock[]): Message {
  return { role: "user", content };
}

function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

const textBlock = (text: string): ContentBlock => ({ type: "text", text });

const imageBlock: ContentBlock = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
};

const memoryTextBlock: ContentBlock = {
  type: "text",
  text: "<memory __injected>\nSome recalled context\n</memory>",
};

const memoryImageMarker: ContentBlock = {
  type: "text",
  text: "<memory_image __injected>\nA photo of a sunset",
};

const memoryImageClose: ContentBlock = {
  type: "text",
  text: "</memory_image>",
};

// Legacy 2-block format (persisted in older conversations)
const legacyMemoryImageMarker: ContentBlock = {
  type: "text",
  text: "<memory_image>A photo of a sunset</memory_image>",
};

const memoryImage: ContentBlock = {
  type: "image",
  source: {
    type: "base64",
    media_type: "image/jpeg",
    data: "/9j/4AAQ==",
  },
};

describe("stripExistingMemoryInjections", () => {
  test("no-op when content has no memory blocks", () => {
    const messages = [userMsg(textBlock("hello"), imageBlock)];
    const result = stripExistingMemoryInjections(messages);
    expect(result).toEqual(messages);
  });

  test("no-op for empty messages array", () => {
    const result = stripExistingMemoryInjections([]);
    expect(result).toEqual([]);
  });

  test("no-op when last message is assistant role", () => {
    const messages = [userMsg(textBlock("hi")), assistantMsg("hey")];
    const result = stripExistingMemoryInjections(messages);
    expect(result).toEqual(messages);
  });

  test("strips memory text block", () => {
    const messages = [userMsg(memoryTextBlock, textBlock("hello"))];
    const result = stripExistingMemoryInjections(messages);
    expect(result[0].content).toEqual([textBlock("hello")]);
  });

  test("strips 3-block memory image (marker + image + close)", () => {
    const messages = [
      userMsg(
        memoryTextBlock,
        memoryImageMarker,
        memoryImage,
        memoryImageClose,
        textBlock("hi"),
      ),
    ];
    const result = stripExistingMemoryInjections(messages);
    expect(result[0].content).toEqual([textBlock("hi")]);
  });

  test("strips multiple 3-block memory image groups", () => {
    const messages = [
      userMsg(
        memoryTextBlock,
        memoryImageMarker,
        memoryImage,
        memoryImageClose,
        memoryImageMarker,
        memoryImage,
        memoryImageClose,
        textBlock("hello"),
      ),
    ];
    const result = stripExistingMemoryInjections(messages);
    expect(result[0].content).toEqual([textBlock("hello")]);
  });

  test("strips legacy 2-block memory image (no closing tag)", () => {
    const messages = [
      userMsg(
        memoryTextBlock,
        legacyMemoryImageMarker,
        memoryImage,
        textBlock("hi"),
      ),
    ];
    const result = stripExistingMemoryInjections(messages);
    expect(result[0].content).toEqual([textBlock("hi")]);
  });

  test("preserves user-attached image when it is the only content", () => {
    const messages = [userMsg(imageBlock)];
    const result = stripExistingMemoryInjections(messages);
    expect(result[0].content).toEqual([imageBlock]);
  });

  test("preserves user-attached image with text", () => {
    const messages = [userMsg(imageBlock, textBlock("what is this?"))];
    const result = stripExistingMemoryInjections(messages);
    expect(result[0].content).toEqual([imageBlock, textBlock("what is this?")]);
  });

  test("preserves user image after stripping 3-block memory blocks", () => {
    const messages = [
      userMsg(
        memoryTextBlock,
        memoryImageMarker,
        memoryImage,
        memoryImageClose,
        imageBlock,
        textBlock("look at this"),
      ),
    ];
    const result = stripExistingMemoryInjections(messages);
    expect(result[0].content).toEqual([imageBlock, textBlock("look at this")]);
  });

  test("preserves user image-only message after stripping memory blocks", () => {
    const messages = [userMsg(memoryTextBlock, imageBlock)];
    const result = stripExistingMemoryInjections(messages);
    expect(result[0].content).toEqual([imageBlock]);
  });

  test("does not modify earlier messages", () => {
    const earlier = userMsg(textBlock("first"));
    const messages = [
      earlier,
      assistantMsg("ok"),
      userMsg(memoryTextBlock, textBlock("second")),
    ];
    const result = stripExistingMemoryInjections(messages);
    expect(result[0]).toBe(earlier);
    expect(result[2].content).toEqual([textBlock("second")]);
  });

  test("does not strip user text that equals </memory_image>", () => {
    const messages = [userMsg(textBlock("</memory_image>"))];
    const result = stripExistingMemoryInjections(messages);
    expect(result[0].content).toEqual([textBlock("</memory_image>")]);
  });

  test("does not strip </memory_image> after memory text block (no image context)", () => {
    const messages = [
      userMsg(
        memoryTextBlock,
        textBlock("</memory_image>"),
        textBlock("hello"),
      ),
    ];
    const result = stripExistingMemoryInjections(messages);
    expect(result[0].content).toEqual([
      textBlock("</memory_image>"),
      textBlock("hello"),
    ]);
  });

  test("strips images-first then text (actual injectMemoryBlock order)", () => {
    const messages = [
      userMsg(
        memoryImageMarker,
        memoryImage,
        memoryImageClose,
        memoryTextBlock,
        textBlock("hello"),
      ),
    ];
    const result = stripExistingMemoryInjections(messages);
    expect(result[0].content).toEqual([textBlock("hello")]);
  });

  // Regression guard: the helper must remain last-message-only — memory-v3's
  // frozen-card carry depends on historical `<memory>` blocks staying intact.
  test("strips ONLY the last user message, leaving earlier ones injected", () => {
    const messages = [
      userMsg(memoryTextBlock, textBlock("first")),
      assistantMsg("ok"),
      userMsg(memoryTextBlock, textBlock("second")),
    ];
    const result = stripExistingMemoryInjections(messages);
    // Earlier user message keeps its injected memory block.
    expect(result[0].content).toEqual([memoryTextBlock, textBlock("first")]);
    // Last user message is stripped.
    expect(result[2].content).toEqual([textBlock("second")]);
  });
});

// ---------------------------------------------------------------------------
// stripPointerInjections: memory-v3 pointer blocks are removed from every user
// message (the per-turn strip-and-replace, and compaction cleanup). Frozen
// `<memory>` section blocks must never be touched (the cache contract).
// ---------------------------------------------------------------------------

const pointerBlock = (inner: string): ContentBlock => ({
  type: "text",
  text: wrapMemoryPointerBlock(inner),
});

describe("stripPointerInjections", () => {
  test("strips pointer blocks from every user message, leaving <memory> blocks intact", () => {
    const messages = [
      userMsg(memoryTextBlock, textBlock("first"), pointerBlock("p1")),
      assistantMsg("ok"),
      userMsg(memoryTextBlock, textBlock("second"), pointerBlock("p2")),
    ];
    const result = stripPointerInjections(messages);
    expect(result[0].content).toEqual([memoryTextBlock, textBlock("first")]);
    expect(result[1]).toBe(messages[1]); // assistant message untouched
    expect(result[2].content).toEqual([memoryTextBlock, textBlock("second")]);
  });

  test("requires the full wrapper: user text merely starting with the tag survives", () => {
    const lookalike = textBlock("<memory_pointer>\nnot really a block");
    const messages = [userMsg(lookalike, textBlock("hello"))];
    const result = stripPointerInjections(messages);
    expect(result[0].content).toEqual([lookalike, textBlock("hello")]);
  });

  test("content no-op when no pointer blocks exist", () => {
    const messages = [
      userMsg(memoryTextBlock, textBlock("hello")),
      assistantMsg("hi"),
      userMsg(imageBlock),
    ];
    const result = stripPointerInjections(messages);
    expect(result).toEqual(messages);
    // Untouched messages keep their identity (cheap no-op detection upstream).
    expect(result[0]).toBe(messages[0]);
  });

  test("no-op for empty messages array", () => {
    expect(stripPointerInjections([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// turnStartUserMessageHasPointer: the cache-anchor volatility signal, read off
// the most recent TEXT-bearing user message so it holds across a tool loop.
// ---------------------------------------------------------------------------

describe("turnStartUserMessageHasPointer", () => {
  const toolResultMsg: Message = {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "ok",
      },
    ],
  };

  test("true when the turn-starting user message carries a pointer block", () => {
    expect(
      turnStartUserMessageHasPointer([
        userMsg(textBlock("hi"), pointerBlock("p1")),
      ]),
    ).toBe(true);
  });

  test("false when the turn start carries only frozen <memory> blocks and text", () => {
    expect(
      turnStartUserMessageHasPointer([
        userMsg(memoryTextBlock, textBlock("hi")),
      ]),
    ).toBe(false);
    expect(turnStartUserMessageHasPointer([])).toBe(false);
  });

  test("skips trailing tool-result messages so the signal holds through a tool loop", () => {
    expect(
      turnStartUserMessageHasPointer([
        userMsg(textBlock("hi"), pointerBlock("p1")),
        assistantMsg("calling a tool"),
        toolResultMsg,
      ]),
    ).toBe(true);
  });

  test("reads the CURRENT turn start, not an earlier user message", () => {
    expect(
      turnStartUserMessageHasPointer([
        userMsg(textBlock("first"), pointerBlock("stale")),
        assistantMsg("ok"),
        userMsg(textBlock("second")),
      ]),
    ).toBe(false);
  });

  test("requires the full wrapper, matching the strip", () => {
    expect(
      turnStartUserMessageHasPointer([
        userMsg(textBlock("<memory_pointer>\nnot really a block")),
      ]),
    ).toBe(false);
  });
});
