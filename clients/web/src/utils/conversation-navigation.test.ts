/**
 * Unit tests for the imperative `navigateToConversation` navigator.
 *
 * Focus: it resets stale viewer state (main view, subagent / workflow panels),
 * updates the active conversation, and fires exactly one haptic tap — unless
 * the caller opts out via `{ silent: true }`. The fork action taps at action
 * start and routes navigation through this helper, so it relies on `silent`
 * to avoid a double buzz.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { NavigateFunction } from "react-router";

import { routes } from "@/utils/routes";

const hapticLight = mock(() => {});
const setMainView = mock((_view: string) => {});
const subagentReset = mock(() => {});
const workflowReset = mock(() => {});
const setActiveConversationId = mock((_id: string) => {});

mock.module("@/utils/haptics", () => ({
  haptic: {
    light: hapticLight,
    medium: () => {},
    success: () => {},
    error: () => {},
  },
}));
mock.module("@/stores/viewer-store", () => ({
  useViewerStore: { getState: () => ({ setMainView }) },
}));
mock.module("@/domains/chat/subagent-store", () => ({
  useSubagentStore: { getState: () => ({ reset: subagentReset }) },
}));
mock.module("@/domains/chat/workflow-store", () => ({
  useWorkflowStore: { getState: () => ({ reset: workflowReset }) },
}));
mock.module("@/stores/conversation-store", () => ({
  useConversationStore: { getState: () => ({ setActiveConversationId }) },
}));

const { navigateToConversation } = await import(
  "@/utils/conversation-navigation"
);

beforeEach(() => {
  hapticLight.mockClear();
  setMainView.mockClear();
  subagentReset.mockClear();
  workflowReset.mockClear();
  setActiveConversationId.mockClear();
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
});
