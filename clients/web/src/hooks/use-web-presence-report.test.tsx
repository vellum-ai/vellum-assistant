/**
 * `useWebPresenceReport` posts tab visibility and focused-conversation state
 * to the daemon on mount, on bus visibility edges, on focused-conversation
 * changes, and on a periodic reconciliation tick while visible, so the daemon can
 * suppress a redundant APNs push while this tab is open on the reply's own
 * conversation. See `assistant/src/runtime/web-presence.ts`.
 *
 * Presence also requires recent user input, so `Date.now` is stubbed to drive
 * the idle threshold.
 *
 * `window.setInterval`/`clearInterval` are stubbed with an armed-timer
 * capture (bun's test runner has no fake timers), matching the pattern in
 * `domains/settings/pair-device/pair-device-test-helpers.ts`; reconciliation
 * ticks are fired by hand via `tickReconciliation()`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router";

import { __resetForTesting, publish } from "@/lib/event-bus";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useConversationStore } from "@/stores/conversation-store";
import { routes } from "@/utils/routes";

const RECONCILIATION_INTERVAL_MS = 60_000;

let visibilityState: "visible" | "hidden" = "visible";
const realVisibilityState = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);

function setVisibilityState(state: "visible" | "hidden") {
  visibilityState = state;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
}

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

function reconciliationTimers(): ArmedInterval[] {
  return armedIntervals.filter(
    (timer) => timer.delay === RECONCILIATION_INTERVAL_MS,
  );
}

/** Fire the (single) live reconciliation interval once. */
function tickReconciliation() {
  const live = reconciliationTimers().filter((timer) => !timer.cleared);
  expect(live).toHaveLength(1);
  act(() => {
    live[0]?.handler();
  });
}

const IDLE_THRESHOLD_MS = 10 * 60_000;

/** Bun has no fake timers, so idle is driven by stubbing the clock. */
let nowMs = 1_700_000_000_000;
const realDateNow = Date.now;

function advanceClock(ms: number) {
  nowMs += ms;
}

/** Deliver a user-input event the hook counts as presence. */
function interact() {
  act(() => {
    window.dispatchEvent(new Event("pointerdown"));
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
  throwOnError?: unknown;
}> = [];
/** Status the stubbed daemon answers reports with. */
let postStatus = 200;
const postMock = mock(async (options: unknown) => {
  postCalls.push(options as (typeof postCalls)[number]);
  return { data: { recorded: true }, response: { status: postStatus } };
});
mock.module("@/generated/daemon/client.gen", () => ({
  client: { post: postMock },
}));

const { useWebPresenceReport, __resetWebPresenceQueueForTests } =
  await import("@/hooks/use-web-presence-report");

/**
 * Reports are serialized, so a second one issued while the first is in flight
 * lands a microtask later. Drain the queue before asserting on `postCalls`.
 */
async function flushPresence(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

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

/** Switch the focused conversation without leaving the chat route. */
function focusConversation(conversationId: string) {
  act(() => {
    useConversationStore.getState().setActiveConversationId(conversationId);
  });
}

function navigateTo(pathname: string) {
  act(() => {
    navigate?.(pathname);
  });
}

beforeEach(() => {
  __resetForTesting();
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-assistant", "0.11.5", "assistant-1");
  useConversationStore.getState().reset();
  electron = false;
  postCalls.length = 0;
  postMock.mockClear();
  navigate = null;
  setVisibilityState("visible");
  postStatus = 200;
  __resetWebPresenceQueueForTests();
  nowMs = 1_700_000_000_000;
  Date.now = () => nowMs;
  installIntervalHarness();
});

afterEach(() => {
  cleanup();
  Date.now = realDateNow;
  __resetForTesting();
  useAssistantIdentityStore.getState().clearIdentity();
  restoreIntervalHarness();
  if (realVisibilityState) {
    Object.defineProperty(document, "visibilityState", realVisibilityState);
  }
});

describe("useWebPresenceReport", () => {
  test("reports visible + focused conversation on mount when on the chat route", async () => {
    useConversationStore.getState().setActiveConversationId("conv-1");

    renderReportAt("assistant-1", routes.conversation("conv-1"));

    await flushPresence();
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]).toEqual({
      url: "/v1/assistants/{assistant_id}/clients/web-presence",
      path: { assistant_id: "assistant-1" },
      body: { visible: true, focusedConversationId: "conv-1" },
      throwOnError: false,
    });
  });

  test("reads visibility fresh for mount and focused-conversation reports", async () => {
    setVisibilityState("hidden");
    useConversationStore.getState().setActiveConversationId("conv-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));

    await flushPresence();
    expect(postCalls[0]?.body).toEqual({
      visible: false,
      focusedConversationId: "conv-1",
    });

    setVisibilityState("visible");
    navigateTo(routes.about);

    await flushPresence();
    expect(postCalls[1]?.body).toEqual({
      visible: true,
      focusedConversationId: null,
    });
  });

  test("reports no focused conversation off the chat route even with an active id", async () => {
    useConversationStore.getState().setActiveConversationId("conv-1");

    renderReportAt("assistant-1", routes.about);

    await flushPresence();
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.body).toEqual({
      visible: true,
      focusedConversationId: null,
    });
  });

  test("does not report until an assistant id resolves", async () => {
    renderReportAt(null);

    await flushPresence();
    expect(postCalls).toHaveLength(0);
  });

  test("does not report or arm reconciliation before an assistant supports the route", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-assistant", "0.11.4", "assistant-1");

    renderReportAt("assistant-1", routes.conversation("conv-1"));

    await flushPresence();
    expect(postCalls).toHaveLength(0);
    expect(reconciliationTimers()).toHaveLength(0);
  });

  test("does not report or subscribe while the assistant version is unknown", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-assistant", null, "assistant-1");

    renderReportAt("assistant-1", routes.conversation("conv-1"));

    await flushPresence();
    expect(postCalls).toHaveLength(0);
    expect(reconciliationTimers()).toHaveLength(0);
  });

  test("starts reporting when identity hydration enables the route", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-assistant", "0.11.4", "assistant-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));
    await flushPresence();
    expect(postCalls).toHaveLength(0);
    expect(reconciliationTimers()).toHaveLength(0);

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("test-assistant", "0.11.5", "assistant-1");
    });

    await flushPresence();
    expect(postCalls).toHaveLength(1);
    expect(reconciliationTimers()).toHaveLength(1);
  });

  test("re-reports after a fresh SSE open for the matching assistant", async () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));
    await flushPresence();
    expect(postCalls).toHaveLength(1);

    act(() => {
      publish("sse.opened", { assistantId: "assistant-1", cause: "fresh" });
    });

    await flushPresence();
    expect(postCalls).toHaveLength(2);
    expect(postCalls[1]?.body).toEqual({
      visible: true,
      focusedConversationId: "conv-1",
    });
  });

  test("re-reports after an SSE reconnect for the matching assistant", async () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));
    setVisibilityState("hidden");

    act(() => {
      publish("sse.opened", { assistantId: "assistant-1", cause: "error" });
    });

    await flushPresence();
    expect(postCalls).toHaveLength(2);
    expect(postCalls[1]?.body).toEqual({
      visible: false,
      focusedConversationId: "conv-1",
    });
  });

  test("ignores SSE opens for another assistant", async () => {
    renderReportAt("assistant-1", routes.conversation("conv-1"));

    act(() => {
      publish("sse.opened", { assistantId: "assistant-2", cause: "fresh" });
    });

    await flushPresence();
    expect(postCalls).toHaveLength(1);
  });

  test("does not report from the Electron renderer", async () => {
    electron = true;
    useConversationStore.getState().setActiveConversationId("conv-1");

    renderReportAt("assistant-1", routes.conversation("conv-1"));

    await flushPresence();
    expect(postCalls).toHaveLength(0);
  });

  test("re-reports when the focused conversation changes via route navigation", async () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));
    await flushPresence();
    expect(postCalls).toHaveLength(1);

    navigateTo(routes.about);

    await flushPresence();
    expect(postCalls).toHaveLength(2);
    expect(postCalls[1]?.body).toEqual({
      visible: true,
      focusedConversationId: null,
    });
  });

  test("reports fresh visibility on app.hidden and app.resume", async () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));
    await flushPresence();
    expect(postCalls).toHaveLength(1);

    setVisibilityState("hidden");
    act(() => {
      publish("app.hidden", { signal: "visibility" });
    });
    await flushPresence();
    expect(postCalls[1]?.body).toEqual({
      visible: false,
      focusedConversationId: "conv-1",
    });

    setVisibilityState("visible");
    act(() => {
      publish("app.resume", { signal: "visibility" });
    });
    await flushPresence();
    expect(postCalls[2]?.body).toEqual({
      visible: true,
      focusedConversationId: "conv-1",
    });
  });

  test("online reconnect while hidden never reports visible", async () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));
    setVisibilityState("hidden");

    act(() => {
      publish("app.resume", { signal: "online" });
    });

    await flushPresence();
    expect(postCalls[1]?.body).toEqual({
      visible: false,
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

describe("useWebPresenceReport: reconciliation", () => {
  test("arms a single 60s reconciliation interval on mount", async () => {
    useConversationStore.getState().setActiveConversationId("conv-1");

    renderReportAt("assistant-1", routes.conversation("conv-1"));

    expect(reconciliationTimers()).toHaveLength(1);
  });

  test("a tick while visible re-reports the focused conversation", async () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));
    await flushPresence();
    expect(postCalls).toHaveLength(1);

    tickReconciliation();

    await flushPresence();
    expect(postCalls).toHaveLength(2);
    expect(postCalls[1]?.body).toEqual({
      visible: true,
      focusedConversationId: "conv-1",
    });
  });

  test("a tick while hidden reports nothing", async () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));
    setVisibilityState("hidden");

    tickReconciliation();

    await flushPresence();
    expect(postCalls).toHaveLength(1);
  });

  test("a tick after app.resume reports again", async () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));
    setVisibilityState("hidden");
    act(() => {
      publish("app.hidden", { signal: "visibility" });
    });
    await flushPresence();
    setVisibilityState("visible");
    act(() => {
      publish("app.resume", { signal: "visibility" });
    });
    await flushPresence();
    expect(postCalls).toHaveLength(3);

    tickReconciliation();

    await flushPresence();
    expect(postCalls).toHaveLength(4);
    expect(postCalls[3]?.body).toEqual({
      visible: true,
      focusedConversationId: "conv-1",
    });
  });

  test("a tick reports the conversation focused at tick time, not at mount", async () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    renderReportAt("assistant-1", routes.conversation("conv-1"));
    await flushPresence();
    expect(postCalls).toHaveLength(1);

    navigateTo(routes.about);
    await flushPresence();
    expect(postCalls).toHaveLength(2);

    tickReconciliation();

    await flushPresence();
    expect(postCalls[2]?.body).toEqual({
      visible: true,
      focusedConversationId: null,
    });
  });

  test("does not arm reconciliation from the Electron renderer", async () => {
    electron = true;
    useConversationStore.getState().setActiveConversationId("conv-1");

    renderReportAt("assistant-1", routes.conversation("conv-1"));

    expect(reconciliationTimers()).toHaveLength(0);
  });

  describe("idle", () => {
    function renderOnConversation() {
      useConversationStore.getState().setActiveConversationId("conv-1");
      return renderReportAt("assistant-1", routes.conversation("conv-1"));
    }

    test("stops reconciling once the tab goes untouched past the threshold", async () => {
      renderOnConversation();
      await flushPresence();
      postCalls.length = 0;

      advanceClock(IDLE_THRESHOLD_MS + 1);
      tickReconciliation();

      // Nothing is posted, so the daemon's last report ages out of its TTL
      // and the push it was suppressing comes back.
      await flushPresence();
      expect(postCalls).toHaveLength(0);
    });

    test("keeps reconciling while input keeps arriving", async () => {
      renderOnConversation();
      await flushPresence();
      postCalls.length = 0;

      advanceClock(IDLE_THRESHOLD_MS - 1);
      interact();
      advanceClock(IDLE_THRESHOLD_MS - 1);
      tickReconciliation();

      await flushPresence();
      expect(postCalls).toHaveLength(1);
      expect(postCalls[0]?.body).toEqual({
        visible: true,
        focusedConversationId: "conv-1",
      });
    });

    test("input ending an idle stretch reports at once", async () => {
      renderOnConversation();
      advanceClock(IDLE_THRESHOLD_MS + 1);
      await flushPresence();
      postCalls.length = 0;

      interact();

      await flushPresence();
      expect(postCalls).toHaveLength(1);
      expect(postCalls[0]?.body).toEqual({
        visible: true,
        focusedConversationId: "conv-1",
      });

      // Only the transition reports; later input rides the tick instead.
      interact();
      await flushPresence();
      expect(postCalls).toHaveLength(1);
    });

    test("input while hidden does not report the tab as visible", async () => {
      renderOnConversation();
      advanceClock(IDLE_THRESHOLD_MS + 1);
      setVisibilityState("hidden");
      await flushPresence();
      postCalls.length = 0;

      interact();

      await flushPresence();
      expect(postCalls).toHaveLength(0);
    });

    test("a foreground resume counts as the user reaching for this tab", async () => {
      renderOnConversation();
      advanceClock(IDLE_THRESHOLD_MS + 1);
      await flushPresence();
      postCalls.length = 0;

      act(() => {
        publish("app.resume", { signal: "visibility" });
      });

      await flushPresence();
      expect(postCalls[0]?.body).toEqual({
        visible: true,
        focusedConversationId: "conv-1",
      });
    });

    test("an online resume does not clear idle", async () => {
      renderOnConversation();
      advanceClock(IDLE_THRESHOLD_MS + 1);
      await flushPresence();
      postCalls.length = 0;

      act(() => {
        publish("app.resume", { signal: "online" });
      });

      await flushPresence();
      expect(postCalls[0]?.body).toEqual({
        visible: false,
        focusedConversationId: "conv-1",
      });
    });
  });

  describe("lifecycle edges are authoritative", () => {
    // On iOS the Capacitor app-state source and `visibilitychange` describe
    // one physical edge and only the first to arrive is published, so the DOM
    // can still read stale when the handler runs and never fires to correct
    // it. Reading `visibilityState` here would report a backgrounded app as
    // visible and suppress its pushes for the rest of the TTL.
    test("app.hidden reports invisible even while the DOM still reads visible", async () => {
      useConversationStore.getState().setActiveConversationId("conv-1");
      renderReportAt("assistant-1", routes.conversation("conv-1"));
      await flushPresence();
      postCalls.length = 0;

      setVisibilityState("visible");
      act(() => {
        publish("app.hidden", { signal: "app_state" });
      });

      await flushPresence();
      expect(postCalls[0]?.body).toEqual({
        visible: false,
        focusedConversationId: "conv-1",
      });
    });

    test("a foreground resume reports visible even while the DOM still reads hidden", async () => {
      useConversationStore.getState().setActiveConversationId("conv-1");
      renderReportAt("assistant-1", routes.conversation("conv-1"));
      await flushPresence();
      postCalls.length = 0;

      setVisibilityState("hidden");
      act(() => {
        publish("app.resume", { signal: "app_state" });
      });

      await flushPresence();
      expect(postCalls[0]?.body).toEqual({
        visible: true,
        focusedConversationId: "conv-1",
      });
    });
  });

  describe("assistants without the route", () => {
    test("a 404 stops reporting instead of repeating on every edge", async () => {
      postStatus = 404;
      useConversationStore.getState().setActiveConversationId("conv-1");
      renderReportAt("assistant-1", routes.conversation("conv-1"));
      await flushPresence();
      expect(postCalls).toHaveLength(1);

      act(() => {
        publish("app.hidden", { signal: "visibility" });
      });
      tickReconciliation();

      await flushPresence();
      expect(postCalls).toHaveLength(1);
    });

    // `sse-service` publishes `sse.opened` from `onReconnect` too, so a
    // transport blip on a route-less build must not hand back another 404.
    test("an ordinary SSE reopen does not retry a route-less build", async () => {
      postStatus = 404;
      useConversationStore.getState().setActiveConversationId("conv-1");
      renderReportAt("assistant-1", routes.conversation("conv-1"));
      await flushPresence();
      postCalls.length = 0;

      act(() => {
        publish("sse.opened", { assistantId: "assistant-1", cause: "error" });
      });
      tickReconciliation();

      await flushPresence();
      expect(postCalls).toHaveLength(0);
    });

    test("a daemon upgrade retries, since the build is a different one", async () => {
      postStatus = 404;
      useConversationStore.getState().setActiveConversationId("conv-1");
      renderReportAt("assistant-1", routes.conversation("conv-1"));
      await flushPresence();
      postCalls.length = 0;
      postStatus = 200;

      act(() => {
        useAssistantIdentityStore
          .getState()
          .setIdentity("test-assistant", "0.11.6", "assistant-1");
      });
      await flushPresence();
      expect(postCalls).toHaveLength(1);
      expect(postCalls[0]?.body).toEqual({
        visible: true,
        focusedConversationId: "conv-1",
      });
    });

    test("a 404 on one build does not silence a different assistant", async () => {
      postStatus = 404;
      useConversationStore.getState().setActiveConversationId("conv-1");
      const { unmount } = renderReportAt(
        "assistant-1",
        routes.conversation("conv-1"),
      );
      await flushPresence();
      unmount();
      postCalls.length = 0;
      postStatus = 200;

      act(() => {
        useAssistantIdentityStore
          .getState()
          .setIdentity("other-assistant", "0.11.5", "assistant-2");
      });
      renderReportAt("assistant-2", routes.conversation("conv-1"));

      await flushPresence();
      expect(postCalls).toHaveLength(1);
    });
  });

  describe("report ordering", () => {
    test("a report issued mid-flight is sent after the one in flight", async () => {
      useConversationStore.getState().setActiveConversationId("conv-1");
      renderReportAt("assistant-1", routes.conversation("conv-1"));
      focusConversation("conv-2");

      // The switch lands behind the mount report rather than racing it,
      // so the daemon can never be left holding the conversation just left.
      expect(postCalls).toHaveLength(1);

      await flushPresence();

      expect(postCalls).toHaveLength(2);
      expect(postCalls[1]?.body).toEqual({
        visible: true,
        focusedConversationId: "conv-2",
      });
    });

    test("only the newest report survives the wait", async () => {
      useConversationStore.getState().setActiveConversationId("conv-1");
      renderReportAt("assistant-1", routes.conversation("conv-1"));
      focusConversation("conv-2");
      focusConversation("conv-3");

      await flushPresence();

      // conv-2 is dropped: by the time it could be sent it already describes
      // a conversation the user has left.
      expect(postCalls).toHaveLength(2);
      expect(postCalls[1]?.body).toEqual({
        visible: true,
        focusedConversationId: "conv-3",
      });
    });
  });

  test("does not arm reconciliation until an assistant id resolves", async () => {
    renderReportAt(null);

    expect(reconciliationTimers()).toHaveLength(0);
  });

  test("unmount clears the reconciliation interval", async () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    const { unmount } = renderReportAt(
      "assistant-1",
      routes.conversation("conv-1"),
    );

    unmount();

    expect(reconciliationTimers()[0]?.cleared).toBe(true);
  });
});
