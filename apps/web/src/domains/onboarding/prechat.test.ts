import { describe, expect, test } from "bun:test";

import {
  buildPreChatInitialMessage,
  DEFAULT_PRECHAT_INITIAL_MESSAGE,
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
