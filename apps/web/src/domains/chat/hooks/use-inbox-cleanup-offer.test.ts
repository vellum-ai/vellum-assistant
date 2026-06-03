import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useInboxCleanupOffer } from "@/domains/chat/hooks/use-inbox-cleanup-offer";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";

const INBOX_CLEANUP_TASK_ID = "inbox-cleanup";

const CONVERSATION_ID = "conv-onboarding";

const greeting: DisplayMessage[] = [{ id: "m1", role: "assistant" }];

interface OverrideOptions {
  didOnboarding?: boolean;
  firstTask?: string | null;
  activationFlowEnabled?: boolean;
  messages?: DisplayMessage[];
  activeConversationId?: string | null;
  onboardingConversationId?: string | null;
  sendMessage?: (content: string) => void;
}

function baseOptions(overrides: OverrideOptions = {}) {
  return {
    didOnboarding: overrides.didOnboarding ?? true,
    firstTask:
      overrides.firstTask === undefined
        ? INBOX_CLEANUP_TASK_ID
        : overrides.firstTask,
    activationFlowEnabled: overrides.activationFlowEnabled ?? true,
    messages: overrides.messages ?? greeting,
    activeConversationId:
      overrides.activeConversationId === undefined
        ? CONVERSATION_ID
        : overrides.activeConversationId,
    onboardingConversationId:
      overrides.onboardingConversationId === undefined
        ? CONVERSATION_ID
        : overrides.onboardingConversationId,
    sendMessage: overrides.sendMessage ?? (() => {}),
  };
}

afterEach(() => {
  cleanup();
});

describe("useInboxCleanupOffer", () => {
  test("hidden when the activation flag is off", () => {
    const { result } = renderHook(() =>
      useInboxCleanupOffer(baseOptions({ activationFlowEnabled: false })),
    );
    expect(result.current.showInboxOffer).toBe(false);
  });

  test("hidden when firstTask does not match inbox-cleanup", () => {
    const { result } = renderHook(() =>
      useInboxCleanupOffer(baseOptions({ firstTask: "something-else" })),
    );
    expect(result.current.showInboxOffer).toBe(false);
  });

  test("hidden when the assistant greeting has not arrived", () => {
    const { result } = renderHook(() =>
      useInboxCleanupOffer(
        baseOptions({ messages: [{ id: "u1", role: "user" }] }),
      ),
    );
    expect(result.current.showInboxOffer).toBe(false);
  });

  test("hidden when not on the onboarding conversation", () => {
    const { result } = renderHook(() =>
      useInboxCleanupOffer(baseOptions({ activeConversationId: "other" })),
    );
    expect(result.current.showInboxOffer).toBe(false);
  });

  test("shown when all conditions are met", () => {
    const { result } = renderHook(() =>
      useInboxCleanupOffer(baseOptions()),
    );
    expect(result.current.showInboxOffer).toBe(true);
  });

  test("handleAccept sends exactly one message and hides the card", () => {
    const sendMessage = mock((_content: string) => {});
    const { result } = renderHook(() =>
      useInboxCleanupOffer(baseOptions({ sendMessage })),
    );
    expect(result.current.showInboxOffer).toBe(true);

    act(() => {
      result.current.handleAccept();
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(result.current.showInboxOffer).toBe(false);
    expect(result.current.accepting).toBe(true);
  });

  test("handleDecline hides the card without sending", () => {
    const sendMessage = mock((_content: string) => {});
    const { result } = renderHook(() =>
      useInboxCleanupOffer(baseOptions({ sendMessage })),
    );
    expect(result.current.showInboxOffer).toBe(true);

    act(() => {
      result.current.handleDecline();
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.current.showInboxOffer).toBe(false);
    expect(result.current.accepting).toBe(false);
  });

  test("dismissed card never reappears", () => {
    const { result } = renderHook(() =>
      useInboxCleanupOffer(baseOptions()),
    );
    expect(result.current.showInboxOffer).toBe(true);

    act(() => {
      result.current.handleDecline();
    });
    expect(result.current.showInboxOffer).toBe(false);
  });
});
