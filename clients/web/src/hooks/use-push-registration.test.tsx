/**
 * The effect that owns the Android shell's foreground-handler flag. The shell
 * renders a data-only push itself whenever the flag says the web layer holds no
 * handler, so a mount that forgets to raise it double-renders and an unmount
 * that forgets to lower it drops the push entirely.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

import { useConversationStore } from "@/stores/conversation-store";
import { routes } from "@/utils/routes";

const realPushRegistration = await import("@/runtime/push-registration");

type Handler = ((push: unknown) => void) | null;

const handlerCalls: Handler[] = [];
const setForegroundPushHandlerMock = mock((handler: Handler) => {
  handlerCalls.push(handler);
});
const registerCalls: string[] = [];
const registerForRemotePushMock = mock(async (assistantId: string) => {
  registerCalls.push(assistantId);
});
mock.module("@/runtime/push-registration", () => ({
  ...realPushRegistration,
  registerForRemotePush: registerForRemotePushMock,
  setForegroundPushHandler: setForegroundPushHandlerMock,
}));

const foregroundPushHandler = mock((_push: unknown, _context: unknown) => {});
mock.module("@/runtime/notifications", () => ({
  postForegroundRemotePush: foregroundPushHandler,
  isFocusedNotificationConversation: (conversationId: string) =>
    conversationId === useConversationStore.getState().activeConversationId,
}));

const { usePushRegistration } = await import("@/hooks/use-push-registration");

beforeEach(() => {
  handlerCalls.length = 0;
  registerCalls.length = 0;
  setForegroundPushHandlerMock.mockClear();
  registerForRemotePushMock.mockClear();
  foregroundPushHandler.mockClear();
  useConversationStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe("usePushRegistration", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[routes.assistant]}>{children}</MemoryRouter>
  );

  test("installs the handler and registers while an assistant is active", () => {
    renderHook(() => usePushRegistration("assistant-1"), { wrapper });

    expect(handlerCalls).toHaveLength(1);
    expect(typeof handlerCalls[0]).toBe("function");
    expect(registerCalls).toEqual(["assistant-1"]);
  });

  test("clears the handler on unmount so the shell takes the push back", () => {
    const { unmount } = renderHook(() => usePushRegistration("assistant-1"), {
      wrapper,
    });
    unmount();

    expect(handlerCalls).toHaveLength(2);
    expect(typeof handlerCalls[0]).toBe("function");
    expect(handlerCalls[1]).toBeNull();
  });

  /**
   * The early exit is what makes the previous cleanup's clear stick: touching
   * the handler here would re-install it for an assistant that is gone.
   */
  test("leaves the previous cleanup's clear in place when the assistant goes away", () => {
    const { rerender } = renderHook(
      ({ assistantId }: { assistantId: string | null }) =>
        usePushRegistration(assistantId),
      {
        wrapper,
        initialProps: { assistantId: "assistant-1" as string | null },
      },
    );

    rerender({ assistantId: null });

    expect(handlerCalls).toHaveLength(2);
    expect(typeof handlerCalls[0]).toBe("function");
    expect(handlerCalls[1]).toBeNull();
    expect(registerCalls).toEqual(["assistant-1"]);
  });

  test("passes the live chat visibility policy to foreground FCM", () => {
    useConversationStore.setState({ activeConversationId: "conv-1" });
    renderHook(() => usePushRegistration("assistant-1"), { wrapper });

    handlerCalls[0]?.({ data: { conversationId: "conv-1" } });

    const context = foregroundPushHandler.mock.calls[0]?.[1] as {
      shouldSuppressConversation: (conversationId: string) => boolean;
    };
    expect(context.shouldSuppressConversation("conv-1")).toBe(true);
    expect(context.shouldSuppressConversation("conv-2")).toBe(false);
  });
});
