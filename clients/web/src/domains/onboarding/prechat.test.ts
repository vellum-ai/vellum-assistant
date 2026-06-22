import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildPreChatInitialMessage,
  consumePendingPreChatContext,
  DEFAULT_PRECHAT_INITIAL_MESSAGE,
  preChatOnboardingProfileFields,
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

describe("preChatOnboardingProfileFields", () => {
  const base: PreChatOnboardingContext = { tools: [], tasks: [], tone: "warm" };

  test("maps occupation through, trimmed", () => {
    expect(
      preChatOnboardingProfileFields({ ...base, occupation: "  Designer  " })
        .occupation,
    ).toBe("Designer");
  });

  test("omits occupation when absent or blank", () => {
    expect(preChatOnboardingProfileFields(base).occupation).toBeUndefined();
    expect(
      preChatOnboardingProfileFields({ ...base, occupation: "   " }).occupation,
    ).toBeUndefined();
  });
});

describe("pending pre-chat context round-trip — occupation", () => {
  // Minimal Map-backed sessionStorage shim, installed/removed per-test so it
  // can't leak into other test files sharing the bun process.
  let store: Map<string, string>;
  let prior: PropertyDescriptor | undefined;

  beforeEach(() => {
    store = new Map();
    prior = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });

  afterEach(() => {
    if (prior) {
      Object.defineProperty(globalThis, "sessionStorage", prior);
    } else {
      delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
  });

  test("occupation survives set → consume", () => {
    setPendingPreChatContext({
      tools: [],
      tasks: [],
      tone: "warm",
      occupation: "Software Engineer",
    });
    expect(consumePendingPreChatContext()?.occupation).toBe(
      "Software Engineer",
    );
  });

  test("a non-string occupation is rejected by validation", () => {
    store.set(
      "onboarding.prechat.pendingContext",
      JSON.stringify({ tools: [], tasks: [], tone: "warm", occupation: 42 }),
    );
    expect(consumePendingPreChatContext()).toBeNull();
  });
});
