/**
 * Pins that `applyPersonality` persists the raw dial positions as the
 * `data/personality-sliders.json` workspace sidecar — the About Assistant
 * personality page and the overview's signature read it, so skipping the save
 * left both empty after onboarding (the prose rewrite alone loses the
 * numbers). Kept separate from `apply-personality.test.ts` so the pure
 * message-builder tests stay free of module mocks.
 *
 * Also pins that the rewrite send goes out hidden (see
 * `lib/side-conversation-message.ts`) and that the throwaway thread is minted
 * `background`, which is what keeps it out of the conversation list.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const conversationsPostMock = mock(
  async (_opts: { body: { conversationType?: string } }) => ({
    data: { id: "conv-1" },
    response: { ok: true },
  }),
);
const messagesPostMock = mock(
  async (_opts: { body: { hidden?: boolean } }) => ({
    response: { ok: true },
  }),
);
const messagesGetMock = mock(async () => ({
  data: {
    processing: false,
    messages: [
      {
        role: "assistant",
        contentBlocks: [{ type: "text", text: "All rewritten!" }],
      },
    ],
  },
}));
const archivePostMock = mock(async () => ({ response: { ok: true } }));
mock.module("@/generated/daemon/sdk.gen", () => ({
  conversationsPost: conversationsPostMock,
  messagesPost: messagesPostMock,
  messagesGet: messagesGetMock,
  conversationsByIdArchivePost: archivePostMock,
}));

const saveSlidersMock = mock(async () => true);
mock.module("@/assistant/personality-sliders", () => ({
  completeSliderValues: (values: Record<string, number>) => ({
    "companion-coworker": 50,
    ...values,
  }),
  savePersonalitySliders: saveSlidersMock,
}));
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

const { applyPersonality } = await import("./apply-personality");

beforeEach(() => {
  conversationsPostMock.mockClear();
  messagesPostMock.mockClear();
  archivePostMock.mockClear();
  saveSlidersMock.mockClear();
});

describe("applyPersonality rewrite prompt", () => {
  test("mints a background thread and posts the rewrite prompt as a hidden machine signal", async () => {
    // The thread's only renderable content is the assistant's first-person
    // self-description (the prompt posts hidden), so the `background` mint is
    // what keeps it out of the user's view. See
    // `lib/side-conversation-message.ts` for why the prompt posts hidden.
    await applyPersonality({
      awaitAssistantId: async () => "ast-1",
      values: {},
    });

    expect(conversationsPostMock.mock.calls[0]?.[0].body).toMatchObject({
      conversationType: "background",
      title: "Updating personality",
    });
    expect(messagesPostMock.mock.calls[0]?.[0].body.hidden).toBe(true);
  });
});

describe("applyPersonality slider persistence", () => {
  test("saves the completed slider values once the rewrite message posts", async () => {
    await applyPersonality({
      awaitAssistantId: async () => "ast-1",
      values: { "playful-serious": 80 },
    });

    expect(saveSlidersMock).toHaveBeenCalledTimes(1);
    expect(saveSlidersMock.mock.calls[0]).toEqual([
      "ast-1",
      { "companion-coworker": 50, "playful-serious": 80 },
    ] as never);
  });

  test("skips the save when the rewrite message fails to post", async () => {
    messagesPostMock.mockResolvedValueOnce({ response: { ok: false } });

    await applyPersonality({
      awaitAssistantId: async () => "ast-1",
      values: { "playful-serious": 80 },
    });

    expect(saveSlidersMock).not.toHaveBeenCalled();
  });
});
