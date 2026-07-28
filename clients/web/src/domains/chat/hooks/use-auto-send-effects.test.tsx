/**
 * Covers the `?prompt=` auto-send dedupe: a prompt is sent once per distinct
 * dispatch, where "distinct" keys on the `relay` token when present (so an app
 * can relay the same text repeatedly) and falls back to the prompt text for
 * one-shot callers (deep links, document feedback). One-shot prompts are also
 * stripped from the URL after dispatch so a refresh can't re-send them.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

import { useAutoSendEffects } from "@/domains/chat/hooks/use-auto-send-effects";

afterEach(() => cleanup());

type SetSearchParamsArgs = [unknown, unknown?];

function baseProps(search: string, sendMessage: (content: string) => Promise<void>) {
  return {
    assistantId: "assistant-1",
    activeConversationId: "conv-1",
    searchParams: new URLSearchParams(search),
    setSearchParams: mock((..._args: SetSearchParamsArgs) => {}),
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

  it("strips a one-shot prompt from the URL after dispatch, keeping other params", () => {
    const sendMessage = mock(async (_content: string) => {});
    const props = baseProps("prompt=hello&vref=research_checkin", sendMessage);
    renderHook((p) => useAutoSendEffects(p), { initialProps: props });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(props.setSearchParams).toHaveBeenCalledTimes(1);
    const updater = props.setSearchParams.mock.calls[0][0] as (
      prev: URLSearchParams,
    ) => URLSearchParams;
    const next = updater(
      new URLSearchParams("prompt=hello&vref=research_checkin"),
    );
    expect(next.has("prompt")).toBe(false);
    // Unrelated params (e.g. the attribution token) are left for their owners.
    expect(next.get("vref")).toBe("research_checkin");
  });

  it("does not strip the prompt for relay callers", () => {
    const sendMessage = mock(async (_content: string) => {});
    const props = baseProps("prompt=hello&relay=a", sendMessage);
    renderHook((p) => useAutoSendEffects(p), { initialProps: props });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(props.setSearchParams).not.toHaveBeenCalled();
  });
});
