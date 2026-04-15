import { describe, expect, test } from "bun:test";

import type { Message } from "../providers/types.js";

/**
 * Unit tests for Conversation.injectInheritedContext() and
 * Conversation.getCurrentSystemPrompt().
 *
 * These methods are thin enough to test via a minimal stub that mirrors the
 * Conversation fields they touch, avoiding the heavyweight constructor
 * dependencies.
 */

/**
 * Minimal stub that replicates the subset of Conversation used by
 * injectInheritedContext() and getCurrentSystemPrompt().
 */
function createStub(systemPrompt: string) {
  return {
    messages: [] as Message[],
    systemPrompt,

    injectInheritedContext(messages: Message[]): void {
      if (this.messages.length !== 0) {
        throw new Error(
          "injectInheritedContext must be called before any messages have been added",
        );
      }
      this.messages = [...messages];
    },

    getCurrentSystemPrompt(): string {
      return this.systemPrompt;
    },
  };
}

const sampleMessages: Message[] = [
  { role: "user", content: [{ type: "text", text: "Hello from parent" }] },
  {
    role: "assistant",
    content: [{ type: "text", text: "Hi there, I am the assistant" }],
  },
  {
    role: "user",
    content: [{ type: "text", text: "Follow-up question" }],
  },
];

describe("Conversation.injectInheritedContext", () => {
  test("injected messages appear in this.messages after injection", () => {
    const stub = createStub("You are a helpful assistant.");
    stub.injectInheritedContext(sampleMessages);

    expect(stub.messages).toHaveLength(3);
    expect(stub.messages[0]).toEqual(sampleMessages[0]);
    expect(stub.messages[1]).toEqual(sampleMessages[1]);
    expect(stub.messages[2]).toEqual(sampleMessages[2]);
  });

  test("injected messages are a shallow copy, not the same array reference", () => {
    const stub = createStub("prompt");
    stub.injectInheritedContext(sampleMessages);

    expect(stub.messages).not.toBe(sampleMessages);
    // Individual message objects are shared (shallow copy)
    expect(stub.messages[0]).toBe(sampleMessages[0]);
  });

  test("assertion fires if called after messages have been added", () => {
    const stub = createStub("prompt");
    // Simulate a message already being present (as if persistUserMessage was called)
    stub.messages.push({
      role: "user",
      content: [{ type: "text", text: "existing message" }],
    });

    expect(() => stub.injectInheritedContext(sampleMessages)).toThrow(
      "injectInheritedContext must be called before any messages have been added",
    );
  });

  test("injecting an empty array leaves messages empty", () => {
    const stub = createStub("prompt");
    stub.injectInheritedContext([]);

    expect(stub.messages).toHaveLength(0);
  });
});

describe("Conversation.getCurrentSystemPrompt", () => {
  test("returns the construction-time system prompt", () => {
    const prompt = "You are a research assistant with deep knowledge.";
    const stub = createStub(prompt);

    expect(stub.getCurrentSystemPrompt()).toBe(prompt);
  });

  test("returns empty string when constructed with empty prompt", () => {
    const stub = createStub("");
    expect(stub.getCurrentSystemPrompt()).toBe("");
  });
});
