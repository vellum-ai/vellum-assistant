/**
 * Covers the `?prompt=` auto-send dedupe: a prompt is sent once per distinct
 * dispatch, where "distinct" keys on the `relay` token when present (so an app
 * can relay the same text repeatedly) and falls back to the prompt text for
 * one-shot callers (deep links, document feedback).
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

import { useAutoSendEffects } from "@/domains/chat/hooks/use-auto-send-effects";

afterEach(() => cleanup());

function baseProps(search: string, sendMessage: (content: string) => Promise<void>) {
  return {
    assistantId: "assistant-1",
    activeConversationId: "conv-1",
    searchParams: new URLSearchParams(search),
    sendMessage,
    reachabilityPhase: "idle" as const,
    reachabilityProbe: () => {},
    getPendingInitialMessage: () => undefined,
  };
}

describe("useAutoSendEffects — URL prompt dedupe", () => {
  it("sends once and ignores an identical re-render", () => {
    const sendMessage = mock(async (_content: string) => {});
    const props = baseProps("prompt=hello", sendMessage);
    const { rerender } = renderHook((p) => useAutoSendEffects(p), {
      initialProps: props,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // A fresh URLSearchParams with the same value must not re-send.
    rerender({ ...props, searchParams: new URLSearchParams("prompt=hello") });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("re-fires the same prompt when the relay token changes", () => {
    const sendMessage = mock(async (_content: string) => {});
    const props = baseProps("prompt=hello&relay=a", sendMessage);
    const { rerender } = renderHook((p) => useAutoSendEffects(p), {
      initialProps: props,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);

    rerender({
      ...props,
      searchParams: new URLSearchParams("prompt=hello&relay=b"),
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith("hello");
  });
});
