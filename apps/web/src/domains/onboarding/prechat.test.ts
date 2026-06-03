import { beforeEach, describe, expect, test } from "bun:test";

import {
  buildPreChatInitialMessage,
  consumePendingPreChatContext,
  DEFAULT_PRECHAT_INITIAL_MESSAGE,
  peekPendingPreChatContext,
  type PreChatOnboardingContext,
  setPendingPreChatContext,
} from "@/domains/onboarding/prechat";

describe("buildPreChatInitialMessage", () => {
  test("uses both names when available", () => {
    expect(
      buildPreChatInitialMessage({
        assistantName: "Vela",
        userName: "Alice",
      }),
    ).toBe("Hi Vela, I'm Alice. Nice to meet you.");
  });

  test("uses the user name when assistant name is missing", () => {
    expect(buildPreChatInitialMessage({ userName: "Alice" })).toBe(
      "Hi, I'm Alice. Nice to meet you.",
    );
  });

  test("uses the assistant name when user name is missing", () => {
    expect(buildPreChatInitialMessage({ assistantName: "Vela" })).toBe(
      "Hi Vela. Nice to meet you.",
    );
  });

  test("falls back to the legacy wake-up message when no names are known", () => {
    expect(buildPreChatInitialMessage({})).toBe(
      DEFAULT_PRECHAT_INITIAL_MESSAGE,
    );
    expect(
      buildPreChatInitialMessage({ assistantName: "  ", userName: "  " }),
    ).toBe(DEFAULT_PRECHAT_INITIAL_MESSAGE);
  });
});

describe("firstTask handoff through sessionStorage", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  function contextWithFirstTask(): PreChatOnboardingContext {
    return {
      tools: ["gmail"],
      tasks: ["inbox"],
      tone: "grounded",
      firstTask: "inbox-cleanup",
    };
  }

  test("survives a set -> peek round-trip without consuming it", () => {
    setPendingPreChatContext(contextWithFirstTask());

    const peeked = peekPendingPreChatContext();
    expect(peeked?.firstTask).toBe("inbox-cleanup");

    // Peek is non-destructive: a second peek still sees the value.
    expect(peekPendingPreChatContext()?.firstTask).toBe("inbox-cleanup");
  });

  test("survives a set -> consume read", () => {
    setPendingPreChatContext(contextWithFirstTask());

    const consumed = consumePendingPreChatContext();
    expect(consumed?.firstTask).toBe("inbox-cleanup");

    // Consume is destructive: the value is gone afterwards.
    expect(consumePendingPreChatContext()).toBeNull();
  });

  test("absence of firstTask round-trips as undefined", () => {
    const { firstTask: _omit, ...withoutFirstTask } = contextWithFirstTask();
    setPendingPreChatContext(withoutFirstTask);

    expect(consumePendingPreChatContext()?.firstTask).toBeUndefined();
  });
});
