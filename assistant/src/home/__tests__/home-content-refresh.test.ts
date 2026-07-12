import { describe, expect, mock, test } from "bun:test";

// ─── Mocks ─────────────────────────────────────────────────────────────

let greetingRefreshed = false;
let promptsRefreshed = false;
let greetingCalls = 0;
let promptsCalls = 0;
let greetingGate: Promise<void> = Promise.resolve();

mock.module("../home-greeting.js", () => ({
  refreshPersonalizedGreeting: async () => {
    greetingCalls++;
    await greetingGate;
    return greetingRefreshed;
  },
}));

mock.module("../suggested-prompts.js", () => ({
  refreshAssistantSuggestedPrompts: async () => {
    promptsCalls++;
    return promptsRefreshed;
  },
}));

const publishSpy = mock<(event: unknown) => Promise<void>>(async () => {});
mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: { publish: publishSpy },
}));

mock.module("../../runtime/assistant-event.js", () => ({
  buildAssistantEvent: (e: unknown) => e,
}));

const { revalidateHomeContentInBackground } =
  await import("../home-content-refresh.js");

async function settle(): Promise<void> {
  // Let the fire-and-forget revalidation chain run to completion.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("revalidateHomeContentInBackground", () => {
  test("publishes home_feed_updated when content was refreshed", async () => {
    publishSpy.mockClear();
    greetingRefreshed = true;
    promptsRefreshed = false;

    revalidateHomeContentInBackground();
    await settle();

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy.mock.calls[0]?.[0]).toMatchObject({
      type: "home_feed_updated",
    });
  });

  test("does not publish when both caches were fresh", async () => {
    publishSpy.mockClear();
    greetingRefreshed = false;
    promptsRefreshed = false;

    revalidateHomeContentInBackground();
    await settle();

    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("concurrent calls share a single in-flight revalidation", async () => {
    greetingCalls = 0;
    promptsCalls = 0;
    greetingRefreshed = false;
    promptsRefreshed = false;

    let release!: () => void;
    greetingGate = new Promise((resolve) => {
      release = resolve;
    });

    revalidateHomeContentInBackground();
    revalidateHomeContentInBackground();
    revalidateHomeContentInBackground();

    release();
    greetingGate = Promise.resolve();
    await settle();

    expect(greetingCalls).toBe(1);
    expect(promptsCalls).toBe(1);
  });

  test("a completed run allows a later revalidation", async () => {
    greetingCalls = 0;
    greetingRefreshed = false;
    promptsRefreshed = false;

    revalidateHomeContentInBackground();
    await settle();
    revalidateHomeContentInBackground();
    await settle();

    expect(greetingCalls).toBe(2);
  });
});
