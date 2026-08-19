/**
 * `useWebPresenceReport` posts tab visibility and focused-conversation state
 * to the daemon on mount, on bus visibility edges, and on focused-conversation
 * changes, so the daemon can suppress a redundant APNs push while this tab is
 * open on the reply's own conversation. See `assistant/src/runtime/web-presence.ts`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router";

import { __resetForTesting, publish } from "@/lib/event-bus";
import { useConversationStore } from "@/stores/conversation-store";
import { routes } from "@/utils/routes";

let electron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => electron,
}));

const postCalls: Array<{
  url: string;
  path: unknown;
  body: unknown;
}> = [];
const postMock = mock(async (options: unknown) => {
  postCalls.push(options as { url: string; path: unknown; body: unknown });
  return { data: { recorded: true } };
});
mock.module("@/generated/daemon/client.gen", () => ({
  client: { post: postMock },
}));

const { useWebPresenceReport } = await import(
  "@/hooks/use-web-presence-report"
);

/** Drives the router from a test, since `MemoryRouter` ignores entry changes. */
let navigate: NavigateFunction | null = null;

function NavigationProbe() {
  const navigateFn = useNavigate();
  useEffect(() => {
    navigate = navigateFn;
  }, [navigateFn]);
  return null;
}

function renderReportAt(
  assistantId: string | null,
  pathname: string = routes.conversation("conv-1"),
) {
  return renderHook(() => useWebPresenceReport(assistantId), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[pathname]}>
        <NavigationProbe />
        {children}
      </MemoryRouter>
    ),
  });
}

function navigateTo(pathname: string) {
  act(() => {
    navigate?.(pathname);
  });
}

beforeEach(() => {
  __resetForTesting();
  useConversationStore.getState().reset();
  electron = false;
  postCalls.length = 0;
  postMock.mockClear();
  navigate = null;
});

afterEach(() => {
  cleanup();
  __resetForTesting();
});

describe("useWebPresenceReport", () => {
  test("reports visible + focused conversation on mount when on the chat route", () => {
    useConversationStore.getState().setActiveConversationId("conv-1");

    renderReportAt("assistant-1", routes.conversation("conv-1"));

    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]).toEqual({
      url: "/v1/assistants/{assistant_id}/clients/web-presence",
      path: { assistant_id: "assistant-1" },
      body: { visible: true, focusedConversationId: "conv-1" },
    });
  });

  test("reports no focused conversation off the chat route even with an active id", () => {
    useConversationStore.getState().setActiveConversationId("conv-1");

    renderReportAt("assistant-1", routes.about);

    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.body).toEqual({
      visible: true,
      focusedConversationId: null,
    });
  });

  test("does not report until an assistant id resolves", () => {
    renderReportAt(null);

    expect(postCalls).toHaveLength(0);
  });

  test("does not report from the Electron renderer", () => {
    electron = true;
    useConversationStore.getState().setActiveConversationId("conv-1");

    renderReportAt("assistant-1", routes.conversation("conv-1"));

    expect(postCalls).toHaveLength(0);
  });

  test("re-reports when the focused conversation changes via route navigation", () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));
    expect(postCalls).toHaveLength(1);

    navigateTo(routes.about);

    expect(postCalls).toHaveLength(2);
    expect(postCalls[1]?.body).toEqual({
      visible: true,
      focusedConversationId: null,
    });
  });

  test("reports hidden on app.hidden and visible again on app.resume", () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));
    expect(postCalls).toHaveLength(1);

    act(() => {
      publish("app.hidden", { signal: "visibility" });
    });
    expect(postCalls).toHaveLength(2);
    expect(postCalls[1]?.body).toEqual({
      visible: false,
      focusedConversationId: "conv-1",
    });

    act(() => {
      publish("app.resume", { signal: "visibility" });
    });
    expect(postCalls).toHaveLength(3);
    expect(postCalls[2]?.body).toEqual({
      visible: true,
      focusedConversationId: "conv-1",
    });
  });

  test("swallows a failed report", async () => {
    postMock.mockImplementationOnce(async () => {
      throw new Error("network down");
    });
    useConversationStore.getState().setActiveConversationId("conv-1");

    expect(() =>
      renderReportAt("assistant-1", routes.conversation("conv-1")),
    ).not.toThrow();
  });
});
