/**
 * The effect that owns the Android shell's foreground-handler flag. The shell
 * renders a data-only push itself whenever the flag says the web layer holds no
 * handler, so a mount that forgets to raise it double-renders and an unmount
 * that forgets to lower it drops the push entirely.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

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

const foregroundPushHandler = () => {};
mock.module("@/runtime/notifications", () => ({
  postForegroundRemotePush: foregroundPushHandler,
}));

const { usePushRegistration } = await import("@/hooks/use-push-registration");

beforeEach(() => {
  handlerCalls.length = 0;
  registerCalls.length = 0;
  setForegroundPushHandlerMock.mockClear();
  registerForRemotePushMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("usePushRegistration", () => {
  test("installs the handler and registers while an assistant is active", () => {
    renderHook(() => usePushRegistration("assistant-1"));

    expect(handlerCalls).toEqual([foregroundPushHandler]);
    expect(registerCalls).toEqual(["assistant-1"]);
  });

  test("clears the handler on unmount so the shell takes the push back", () => {
    const { unmount } = renderHook(() => usePushRegistration("assistant-1"));
    unmount();

    expect(handlerCalls).toEqual([foregroundPushHandler, null]);
  });

  /**
   * The early exit is what makes the previous cleanup's clear stick: touching
   * the handler here would re-install it for an assistant that is gone.
   */
  test("leaves the previous cleanup's clear in place when the assistant goes away", () => {
    const { rerender } = renderHook(
      ({ assistantId }: { assistantId: string | null }) =>
        usePushRegistration(assistantId),
      { initialProps: { assistantId: "assistant-1" as string | null } },
    );

    rerender({ assistantId: null });

    expect(handlerCalls).toEqual([foregroundPushHandler, null]);
    expect(registerCalls).toEqual(["assistant-1"]);
  });
});
