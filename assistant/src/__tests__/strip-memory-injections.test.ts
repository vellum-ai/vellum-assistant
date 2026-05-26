import { describe, expect, test } from "bun:test";

import { stripAllMemoryInjections } from "../memory/graph/conversation-graph-memory.js";
import type { ContentBlock, Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// stripAllMemoryInjections — removes memory-injected blocks from the front
// of every user message while preserving user-attached content. Used to
// keep prompt-cache prefixes byte-stable across turns (only the current
// turn's user message should carry fresh memory).
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

describe("stripAllMemoryInjections", () => {
  test("no-op when content has no memory blocks", () => {
    const messages = [userMsg(textBlock("hello"), imageBlock)];
    const result = stripAllMemoryInjections(messages);
    expect(result).toEqual(messages);
  });

  test("no-op for empty messages array", () => {
    const result = stripAllMemoryInjections([]);
    expect(result).toEqual([]);
  });

  test("no-op when last message is assistant role", () => {
    const messages = [userMsg(textBlock("hi")), assistantMsg("hey")];
    const result = stripAllMemoryInjections(messages);
    expect(result).toEqual(messages);
  });

  test("strips memory text block", () => {
    const messages = [userMsg(memoryTextBlock, textBlock("hello"))];
    const result = stripAllMemoryInjections(messages);
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
    const result = stripAllMemoryInjections(messages);
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
    const result = stripAllMemoryInjections(messages);
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
    const result = stripAllMemoryInjections(messages);
    expect(result[0].content).toEqual([textBlock("hi")]);
  });

  test("preserves user-attached image when it is the only content", () => {
    const messages = [userMsg(imageBlock)];
    const result = stripAllMemoryInjections(messages);
    expect(result[0].content).toEqual([imageBlock]);
  });

  test("preserves user-attached image with text", () => {
    const messages = [userMsg(imageBlock, textBlock("what is this?"))];
    const result = stripAllMemoryInjections(messages);
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
    const result = stripAllMemoryInjections(messages);
    expect(result[0].content).toEqual([imageBlock, textBlock("look at this")]);
  });

  test("preserves user image-only message after stripping memory blocks", () => {
    const messages = [userMsg(memoryTextBlock, imageBlock)];
    const result = stripAllMemoryInjections(messages);
    expect(result[0].content).toEqual([imageBlock]);
  });

  test("preserves earlier user messages that have no memory blocks", () => {
    const earlier = userMsg(textBlock("first"));
    const messages = [
      earlier,
      assistantMsg("ok"),
      userMsg(memoryTextBlock, textBlock("second")),
    ];
    const result = stripAllMemoryInjections(messages);
    expect(result[0]).toBe(earlier);
    expect(result[2].content).toEqual([textBlock("second")]);
  });

  test("strips memory from historical user messages too, not just the last", () => {
    const messages = [
      userMsg(memoryTextBlock, textBlock("first")),
      assistantMsg("ok"),
      userMsg(memoryTextBlock, textBlock("second")),
    ];
    const result = stripAllMemoryInjections(messages);
    expect(result[0].content).toEqual([textBlock("first")]);
    expect(result[2].content).toEqual([textBlock("second")]);
  });

  test("strips memory from a mix of historical user messages", () => {
    const noMemoryUser = userMsg(textBlock("clean"));
    const messages = [
      userMsg(memoryTextBlock, textBlock("first")),
      assistantMsg("ok"),
      noMemoryUser,
      assistantMsg("ok again"),
      userMsg(
        memoryImageMarker,
        memoryImage,
        memoryImageClose,
        memoryTextBlock,
        textBlock("third"),
      ),
    ];
    const result = stripAllMemoryInjections(messages);
    expect(result[0].content).toEqual([textBlock("first")]);
    expect(result[2]).toBe(noMemoryUser);
    expect(result[4].content).toEqual([textBlock("third")]);
  });

  test("leaves assistant messages untouched even if they begin with <memory>", () => {
    const assistantWithMemoryShape = assistantMsg(
      "<memory>\nlooks like memory\n</memory>",
    );
    const messages = [
      userMsg(memoryTextBlock, textBlock("hi")),
      assistantWithMemoryShape,
    ];
    const result = stripAllMemoryInjections(messages);
    expect(result[1]).toBe(assistantWithMemoryShape);
  });

  test("does not strip user text that equals </memory_image>", () => {
    const messages = [userMsg(textBlock("</memory_image>"))];
    const result = stripAllMemoryInjections(messages);
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
    const result = stripAllMemoryInjections(messages);
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
    const result = stripAllMemoryInjections(messages);
    expect(result[0].content).toEqual([textBlock("hello")]);
  });
});
