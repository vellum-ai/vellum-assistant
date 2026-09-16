/**
 * Covers the `?prompt=` pathway: a prompt is dispatched once per distinct
 * arrival, where "distinct" keys on the `relay` token when present (so an app
 * can relay the same text repeatedly) and falls back to the prompt text for
 * one-shot callers (document feedback). One-shot prompts are also stripped
 * from the URL after dispatch so a refresh can't replay them.
 *
 * Whether a dispatch *sends* or only *pre-fills* the composer depends on
 * provenance: in-app navigations carry `autoSendPromptState`; a URL opened
 * from outside the SPA (no history state) must never send on the user's
 * behalf.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

import { useAutoSendEffects } from "@/domains/chat/hooks/use-auto-send-effects";
import { autoSendPromptState } from "@/utils/auto-send-prompt";

afterEach(() => cleanup());

type SetSearchParamsArgs = [unknown, unknown?];

function baseProps(
  search: string,
  sendMessage: (content: string) => Promise<void>,
) {
  return {
    assistantId: "assistant-1",
    activeConversationId: "conv-1",
    searchParams: new URLSearchParams(search),
    setSearchParams: mock((..._args: SetSearchParamsArgs) => {}),
    sendMessage,
    prefillComposer: mock((_content: string) => {}),
    // In-app provenance by default; the pre-fill cases override this.
    navigationState: autoSendPromptState() as unknown,
    reachabilityPhase: "idle" as const,
    reachabilityProbe: () => {},
    getPendingInitialMessage: () => undefined,
  };
}

describe("useAutoSendEffects — URL prompt dedupe", () => {
  it("preserves document return history state when consuming a prompt", () => {
    const props = baseProps(
      "prompt=feedback&document=surface-1",
      mock(async () => {}),
    );
    const navigationState = autoSendPromptState({
      documentEntry: { surfaceId: "surface-1", returnTo: "/assistant/library" },
    });
    renderHook(() => useAutoSendEffects({ ...props, navigationState }));
    expect(props.setSearchParams.mock.calls[0][1]).toEqual({
      replace: true,
      state: navigationState,
    });
  });
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

describe("useAutoSendEffects: URL prompt provenance", () => {
  it("pre-fills instead of sending when the URL arrived without in-app state", () => {
    const sendMessage = mock(async (_content: string) => {});
    const props = {
      ...baseProps("prompt=hello&vref=research_checkin", sendMessage),
      navigationState: null,
    };
    renderHook((p) => useAutoSendEffects(p), { initialProps: props });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(props.prefillComposer).toHaveBeenCalledTimes(1);
    expect(props.prefillComposer).toHaveBeenCalledWith("hello");
    // Stripped so a reload does not re-stage it over whatever the user typed.
    const updater = props.setSearchParams.mock.calls[0][0] as (
      prev: URLSearchParams,
    ) => URLSearchParams;
    const next = updater(
      new URLSearchParams("prompt=hello&vref=research_checkin"),
    );
    expect(next.has("prompt")).toBe(false);
    expect(next.get("vref")).toBe("research_checkin");
  });

  it("ignores a relay token on an external link and strips both params", () => {
    const sendMessage = mock(async (_content: string) => {});
    const props = {
      ...baseProps("prompt=hello&relay=a", sendMessage),
      navigationState: undefined,
    };
    renderHook((p) => useAutoSendEffects(p), { initialProps: props });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(props.prefillComposer).toHaveBeenCalledWith("hello");
    const updater = props.setSearchParams.mock.calls[0][0] as (
      prev: URLSearchParams,
    ) => URLSearchParams;
    const next = updater(new URLSearchParams("prompt=hello&relay=a"));
    expect(next.has("prompt")).toBe(false);
    expect(next.has("relay")).toBe(false);
  });

  it("does not treat unrelated history state as authorization to send", () => {
    const sendMessage = mock(async (_content: string) => {});
    const props = {
      ...baseProps("prompt=hello", sendMessage),
      navigationState: {
        documentEntry: { surfaceId: "s", returnTo: "/assistant/library" },
      },
    };
    renderHook((p) => useAutoSendEffects(p), { initialProps: props });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(props.prefillComposer).toHaveBeenCalledWith("hello");
  });

  it("sends when the navigation carries the in-app marker", () => {
    const sendMessage = mock(async (_content: string) => {});
    const props = baseProps("prompt=hello", sendMessage);
    renderHook((p) => useAutoSendEffects(p), { initialProps: props });

    expect(sendMessage).toHaveBeenCalledWith("hello");
    expect(props.prefillComposer).not.toHaveBeenCalled();
  });
});
