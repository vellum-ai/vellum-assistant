/**
 * `useWebPresenceReport` posts tab visibility and focused-conversation state
 * to the daemon on mount, on bus visibility edges, on focused-conversation
 * changes, and on a periodic heartbeat while visible, so the daemon can
 * suppress a redundant APNs push while this tab is open on the reply's own
 * conversation. See `assistant/src/runtime/web-presence.ts`.
 *
 * `window.setInterval`/`clearInterval` are stubbed with an armed-timer
 * capture (bun's test runner has no fake timers), matching the pattern in
 * `domains/settings/pair-device/pair-device-test-helpers.ts`; heartbeat
 * ticks are fired by hand via `tickHeartbeat()`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router";

import { __resetForTesting, publish } from "@/lib/event-bus";
import { useConversationStore } from "@/stores/conversation-store";
import { routes } from "@/utils/routes";

const HEARTBEAT_INTERVAL_MS = 20_000;

interface ArmedInterval {
  handler: () => void;
  delay: number;
  cleared: boolean;
}

const armedIntervals: ArmedInterval[] = [];
const realSetInterval = window.setInterval.bind(window);
const realClearInterval = window.clearInterval.bind(window);

function installIntervalHarness() {
  window.setInterval = ((handler: () => void, delay?: number) => {
    armedIntervals.push({ handler, delay: delay ?? 0, cleared: false });
    return armedIntervals.length as unknown as ReturnType<
      typeof window.setInterval
    >;
  }) as typeof window.setInterval;
  window.clearInterval = ((id: number) => {
    const timer = armedIntervals[id - 1];
    if (timer) {
      timer.cleared = true;
    }
  }) as typeof window.clearInterval;
}

function restoreIntervalHarness() {
  window.setInterval = realSetInterval;
  window.clearInterval = realClearInterval;
  armedIntervals.length = 0;
}

function heartbeatTimers(): ArmedInterval[] {
  return armedIntervals.filter(
    (timer) => timer.delay === HEARTBEAT_INTERVAL_MS,
  );
}

/** Fire the (single) live heartbeat interval once. */
function tickHeartbeat() {
  const live = heartbeatTimers().filter((timer) => !timer.cleared);
  expect(live).toHaveLength(1);
  act(() => {
    live[0]?.handler();
  });
}

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
  installIntervalHarness();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  restoreIntervalHarness();
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

describe("useWebPresenceReport: heartbeat", () => {
  test("arms a single 20s heartbeat interval on mount", () => {
    useConversationStore.getState().setActiveConversationId("conv-1");

    renderReportAt("assistant-1", routes.conversation("conv-1"));

    expect(heartbeatTimers()).toHaveLength(1);
  });

  test("a tick while visible re-reports the focused conversation", () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));
    expect(postCalls).toHaveLength(1);

    tickHeartbeat();

    expect(postCalls).toHaveLength(2);
    expect(postCalls[1]?.body).toEqual({
      visible: true,
      focusedConversationId: "conv-1",
    });
  });

  test("a tick while hidden reports nothing", () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));
    act(() => {
      publish("app.hidden", { signal: "visibility" });
    });
    expect(postCalls).toHaveLength(2);

    tickHeartbeat();

    expect(postCalls).toHaveLength(2);
  });

  test("a tick after app.resume reports again", () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));
    act(() => {
      publish("app.hidden", { signal: "visibility" });
    });
    act(() => {
      publish("app.resume", { signal: "visibility" });
    });
    expect(postCalls).toHaveLength(3);

    tickHeartbeat();

    expect(postCalls).toHaveLength(4);
    expect(postCalls[3]?.body).toEqual({
      visible: true,
      focusedConversationId: "conv-1",
    });
  });

  test("a tick reports the conversation focused at tick time, not at mount", () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));
    expect(postCalls).toHaveLength(1);

    navigateTo(routes.about);
    expect(postCalls).toHaveLength(2);

    tickHeartbeat();

    expect(postCalls[2]?.body).toEqual({
      visible: true,
      focusedConversationId: null,
    });
  });

  test("does not arm a heartbeat from the Electron renderer", () => {
    electron = true;
    useConversationStore.getState().setActiveConversationId("conv-1");

    renderReportAt("assistant-1", routes.conversation("conv-1"));

    expect(heartbeatTimers()).toHaveLength(0);
  });

  test("does not arm a heartbeat until an assistant id resolves", () => {
    renderReportAt(null);

    expect(heartbeatTimers()).toHaveLength(0);
  });

  test("unmount clears the heartbeat interval", () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    const { unmount } = renderReportAt("assistant-1", routes.conversation("conv-1"));

    unmount();

    expect(heartbeatTimers()[0]?.cleared).toBe(true);
  });
});
