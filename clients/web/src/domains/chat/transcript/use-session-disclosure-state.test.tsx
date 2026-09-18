import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "bun:test";

import { useSessionDisclosureState } from "./use-session-disclosure-state";

describe("useSessionDisclosureState", () => {
  test("defaults historical sessions closed and keeps an observed live session open", () => {
    const { result } = renderHook(() => useSessionDisclosureState("conv-123"));

    expect(result.current.isSessionOpen("historic")).toBe(false);
    act(() => result.current.observeLiveSession("live"));
    expect(result.current.isSessionOpen("live")).toBe(true);
  });

  test("remembers live observation before a descriptor arrives", () => {
    const { result, rerender } = renderHook(
      ({ event }) => ({
        disclosure: useSessionDisclosureState("conv-123"),
        event,
      }),
      { initialProps: { event: "membership" } },
    );

    act(() => result.current.disclosure.observeLiveSession("fast-session"));
    rerender({ event: "completed-summary" });

    expect(result.current.event).toBe("completed-summary");
    expect(result.current.disclosure.isSessionOpen("fast-session")).toBe(true);
  });

  test("explicit user and route choices override the live default", () => {
    const { result } = renderHook(() => useSessionDisclosureState("conv-123"));

    act(() => result.current.observeLiveSession("session-123"));
    act(() => result.current.setSessionOpen("session-123", false));
    expect(result.current.isSessionOpen("session-123")).toBe(false);

    act(() => result.current.setSessionOpen("session-123", true));
    expect(result.current.isSessionOpen("session-123")).toBe(true);

    act(() => result.current.observeLiveSession("session-123"));
    expect(result.current.isSessionOpen("session-123")).toBe(true);
  });

  test("survives transient consumer updates during the same visit", () => {
    const { result, rerender } = renderHook(
      ({ connection, messageCount }) => ({
        disclosure: useSessionDisclosureState("conv-123"),
        connection,
        messageCount,
      }),
      { initialProps: { connection: "connected", messageCount: 1 } },
    );
    act(() => result.current.disclosure.observeLiveSession("session-123"));
    act(() => result.current.disclosure.setSessionOpen("historic", true));

    rerender({ connection: "reconnecting", messageCount: 2 });
    rerender({ connection: "background", messageCount: 3 });
    rerender({ connection: "connected", messageCount: 4 });

    expect(result.current.disclosure.isSessionOpen("session-123")).toBe(true);
    expect(result.current.disclosure.isSessionOpen("historic")).toBe(true);
  });

  test("clears choices on conversation exit and ignores stale callbacks", () => {
    const { result, rerender, unmount } = renderHook(
      ({ conversationId }) => useSessionDisclosureState(conversationId),
      { initialProps: { conversationId: "conv-123" as string | null } },
    );
    act(() => result.current.setSessionOpen("session-123", true));
    const staleSetOpen = result.current.setSessionOpen;

    rerender({ conversationId: "conv-456" });
    expect(result.current.isSessionOpen("session-123")).toBe(false);
    act(() => staleSetOpen("session-123", true));
    expect(result.current.isSessionOpen("session-123")).toBe(false);

    rerender({ conversationId: null });
    unmount();

    const nextVisit = renderHook(() => useSessionDisclosureState("conv-123"));
    expect(nextVisit.result.current.isSessionOpen("session-123")).toBe(false);
    nextVisit.unmount();
  });

  test("ignores empty ids and visits without a conversation", () => {
    const { result } = renderHook(() => useSessionDisclosureState(null));
    act(() => result.current.observeLiveSession("session-123"));
    act(() => result.current.setSessionOpen("session-123", true));
    act(() => result.current.setSessionOpen("", true));

    expect(result.current.isSessionOpen("session-123")).toBe(false);
    expect(result.current.isSessionOpen("")).toBe(false);
  });

  test("does not retain or record disclosure state while disabled", () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useSessionDisclosureState("conv-123", enabled),
      { initialProps: { enabled: true } },
    );
    act(() => result.current.observeLiveSession("session-123"));
    expect(result.current.isSessionOpen("session-123")).toBe(true);

    rerender({ enabled: false });
    expect(result.current.isSessionOpen("session-123")).toBe(false);
    act(() => result.current.setSessionOpen("session-123", true));
    expect(result.current.isSessionOpen("session-123")).toBe(false);

    rerender({ enabled: true });
    expect(result.current.isSessionOpen("session-123")).toBe(false);
  });
});
