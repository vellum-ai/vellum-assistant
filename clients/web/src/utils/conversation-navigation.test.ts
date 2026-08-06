/**
 * Unit tests for the imperative `navigateToConversation` and
 * `navigateToNewConversation` navigators.
 *
 * Focus: they reset stale viewer state (main view, subagent / workflow panels,
 * transcript side-panel payloads), update the active conversation, and fire
 * exactly one haptic tap, unless the caller opts out via `{ silent: true }`.
 * The fork action taps at action start and routes navigation through this
 * helper, so it relies on `silent` to avoid a double buzz.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { NavigateFunction } from "react-router";

import { routes } from "@/utils/routes";

const hapticLight = mock(() => {});
const setMainView = mock((_view: string) => {});
const clearTranscriptPanelPayloads = mock(() => {});
const subagentReset = mock(() => {});
const workflowReset = mock(() => {});
const setActiveConversationId = mock((_id: string) => {});
const registerDraftConversationId = mock((_id: string) => {});
const playSound = mock((_name: string) => Promise.resolve());
const composerFocus = mock(() => {});

mock.module("@/utils/haptics", () => ({
  haptic: {
    light: hapticLight,
    medium: () => {},
    success: () => {},
    error: () => {},
  },
}));
mock.module("@/stores/viewer-store", () => ({
  useViewerStore: {
    getState: () => ({ setMainView, clearTranscriptPanelPayloads }),
  },
}));
mock.module("@/lib/sounds/sound-manager", () => ({
  getSoundManager: () => ({ play: playSound }),
}));
mock.module("@/domains/chat/composer-focus", () => ({
  requestComposerFocus: composerFocus,
}));
mock.module("@/domains/chat/subagent-store", () => ({
  useSubagentStore: { getState: () => ({ reset: subagentReset }) },
}));
mock.module("@/domains/chat/workflow-store", () => ({
  useWorkflowStore: { getState: () => ({ reset: workflowReset }) },
}));
let activeConversationId: string | null = null;
mock.module("@/stores/conversation-store", () => ({
  useConversationStore: {
    getState: () => ({
      activeConversationId,
      setActiveConversationId,
      registerDraftConversationId,
    }),
  },
}));

const { navigateToConversation, navigateToNewConversation } = await import(
  "@/utils/conversation-navigation"
);

beforeEach(() => {
  hapticLight.mockClear();
  setMainView.mockClear();
  clearTranscriptPanelPayloads.mockClear();
  subagentReset.mockClear();
  workflowReset.mockClear();
  setActiveConversationId.mockClear();
  registerDraftConversationId.mockClear();
  playSound.mockClear();
  composerFocus.mockClear();
  activeConversationId = null;
});

describe("navigateToConversation", () => {
  test("resets viewer state, sets the active conversation, taps once, navigates", () => {
    const navigate = mock((_to: string) => {});
    navigateToConversation(navigate as unknown as NavigateFunction, "conv-1");

    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(setMainView).toHaveBeenCalledWith("chat");
    expect(subagentReset).toHaveBeenCalledTimes(1);
    expect(workflowReset).toHaveBeenCalledTimes(1);
    expect(setActiveConversationId).toHaveBeenCalledWith("conv-1");
    expect(navigate).toHaveBeenCalledWith(routes.conversation("conv-1"));
  });

  test("silent suppresses the haptic but still resets state and navigates", () => {
    const navigate = mock((_to: string) => {});
    navigateToConversation(navigate as unknown as NavigateFunction, "conv-2", {
      silent: true,
    });

    expect(hapticLight).not.toHaveBeenCalled();
    expect(setMainView).toHaveBeenCalledWith("chat");
    expect(subagentReset).toHaveBeenCalledTimes(1);
    expect(workflowReset).toHaveBeenCalledTimes(1);
    expect(setActiveConversationId).toHaveBeenCalledWith("conv-2");
    expect(navigate).toHaveBeenCalledWith(routes.conversation("conv-2"));
  });

  test("messageId anchors navigation to that message and still taps", () => {
    const navigate = mock((_to: string) => {});
    navigateToConversation(navigate as unknown as NavigateFunction, "conv-3", {
      messageId: "msg-9",
    });

    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      routes.conversationAtMessage("conv-3", "msg-9"),
    );
  });

  test("same-conversation navigation keeps subagent/workflow state (LUM-2875)", () => {
    activeConversationId = "conv-1";
    const navigate = mock((_to: string) => {});
    navigateToConversation(navigate as unknown as NavigateFunction, "conv-1");

    // Still returns to the chat view and navigates, but must NOT wipe the
    // process stores — running subagents only repopulate from live SSE.
    expect(setMainView).toHaveBeenCalledWith("chat");
    expect(subagentReset).not.toHaveBeenCalled();
    expect(workflowReset).not.toHaveBeenCalled();
    expect(clearTranscriptPanelPayloads).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(routes.conversation("conv-1"));
  });

  test("genuine switch resets subagent/workflow state and panel payloads", () => {
    activeConversationId = "conv-1";
    const navigate = mock((_to: string) => {});
    navigateToConversation(navigate as unknown as NavigateFunction, "conv-2");

    expect(subagentReset).toHaveBeenCalledTimes(1);
    expect(workflowReset).toHaveBeenCalledTimes(1);
    // A files or activity-steps panel opened from the previous transcript
    // points at a message this conversation does not contain.
    expect(clearTranscriptPanelPayloads).toHaveBeenCalledTimes(1);
  });
});

describe("navigateToNewConversation", () => {
  test("resets panel payloads and process stores, taps, focuses the composer", () => {
    activeConversationId = "conv-1";
    const navigate = mock((_to: string) => {});
    navigateToNewConversation(navigate as unknown as NavigateFunction);

    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(setMainView).toHaveBeenCalledWith("chat");
    expect(subagentReset).toHaveBeenCalledTimes(1);
    expect(workflowReset).toHaveBeenCalledTimes(1);
    expect(clearTranscriptPanelPayloads).toHaveBeenCalledTimes(1);
    expect(setActiveConversationId).toHaveBeenCalledTimes(1);
    // The minted key is registered as a draft, so the transcript skips its
    // skeleton and lands the composer instead.
    expect(registerDraftConversationId).toHaveBeenCalledTimes(1);
    expect(composerFocus).toHaveBeenCalledTimes(1);
  });

  test("silent suppresses the haptic and sound but still clears panel payloads", () => {
    const navigate = mock((_to: string) => {});
    navigateToNewConversation(navigate as unknown as NavigateFunction, {
      silent: true,
    });

    expect(hapticLight).not.toHaveBeenCalled();
    expect(playSound).not.toHaveBeenCalled();
    expect(clearTranscriptPanelPayloads).toHaveBeenCalledTimes(1);
  });
});
