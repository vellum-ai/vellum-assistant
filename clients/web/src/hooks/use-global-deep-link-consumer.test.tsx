import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { cleanup, renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { consumePendingComposerFocus } from "@/domains/chat/composer-focus";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { __resetForTesting, publish } from "@/lib/event-bus";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import {
  __resetConnectDialogForTesting,
  useConnectDialogStore,
} from "@/stores/connect-dialog-store";
import { useConversationStore } from "@/stores/conversation-store";
import {
  __resetPendingDeepLinkForTesting,
  usePendingDeepLinkStore,
} from "@/stores/pending-deep-link-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";
import * as toastModule from "@vellumai/design-library/components/toast";
import { stubViewportAxes } from "@/hooks/viewport-axes.test-helper";

/**
 * Location the app is "on", advanced by the consumer's own `navigate` calls.
 * The voice-room predicate reads `useLocation`, so driving it from
 * `navigateMock` lets the resume tests assert the room is visible *at the
 * route the deep link actually landed on* rather than at a hand-written path.
 */
let mockPathname: string = routes.assistant;
const navigateMock = mock((to: string) => {
  mockPathname = to.split("?")[0] ?? to;
  return undefined;
});
mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  // Empty `search` is the main window — the room's pop-out gate
  // (`isPopoutWindow`) looks for `popout=1`.
  useLocation: () => ({ pathname: mockPathname, search: "" }),
}));

const ensureMainWindowVisibleMock = mock(async () => undefined);
mock.module("@/runtime/main-window", () => ({
  ensureMainWindowVisible: ensureMainWindowVisibleMock,
}));

// Stub the toaster: the top-up success branch toasts, and no <Toaster /> is
// mounted here. Full toast surface: `mock.module` is process-global in bun,
// so a partial shape would shadow the other methods for later test files.
const toastSuccessMock = mock((..._args: unknown[]) => undefined);
mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastModule,
  toast: Object.assign((..._args: unknown[]) => {}, {
    success: toastSuccessMock,
    error: () => {},
    info: () => {},
    warning: () => {},
  }),
}));

const sentryBreadcrumbMock = mock((_args: unknown) => undefined);
// Full Sentry surface — `mock.module` is process-global in bun, so a
// partial mock would shadow `captureException` (used by `runtime/event-sources/*`
// and `sse-service`) for every later test file in the run.
mock.module("@sentry/react", () => ({
  addBreadcrumb: sentryBreadcrumbMock,
  captureException: () => {},
}));

// Voice entry runs a readiness preflight before a session opens; stub it ready
// so these tests stay about link handling. See `voice-entry-guards`.
mock.module("@/domains/chat/voice/live-voice/live-voice-preflight-api", () => ({
  preflightLiveVoice: async () => ({ status: "ready" }),
}));

const { useGlobalDeepLinkConsumer } =
  await import("./use-global-deep-link-consumer");

// The consumer reads `useQueryClient()` (the top-up success branch refetches
// the billing summary), so every render mounts under a provider. Fresh client
// per test, so cache state can't leak between cases.
let queryClient: QueryClient;
const Wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);
const renderConsumer = () =>
  renderHook(() => useGlobalDeepLinkConsumer(), { wrapper: Wrapper });
const { drainPendingVoiceStart } =
  await import("@/domains/chat/voice/live-voice/start-voice-request");
const { useIsVoiceRoomVisible } =
  await import("@/domains/chat/voice/voice-room/use-is-voice-room-visible");
const { useVoicePrefsStore } = await import("@/stores/voice-prefs-store");

/**
 * Wrap a bare `start` spy in the full starter contract. Only `start` is ever
 * asserted here — the deep-link path has no user gesture to prewarm from, so
 * the other two are inert stubs.
 */
const asStarter = (start: (a: string, c: string | null) => void) => ({
  prewarm: () => {},
  cancelPrewarm: () => {},
  start,
});

const resetStores = () => {
  useViewerStore.getState().reset();
  useSubagentStore.getState().reset();
  useWorkflowStore.getState().reset();
  useConversationStore.getState().reset();
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore.getState().setStarter(null);
  useAssistantIdentityStore.setState({ assistantId: null, version: null });
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
};

/**
 * Make the live-voice eligibility gate pass: an assistant new enough to serve
 * live voice, with the identity version scoped to that same assistant.
 */
const seedEligibleAssistant = (version = "0.10.12") => {
  useAssistantIdentityStore.setState({ assistantId: "assistant-1", version });
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
};

beforeEach(() => {
  __resetForTesting();
  __resetPendingDeepLinkForTesting();
  __resetConnectDialogForTesting();
  mockPathname = routes.assistant;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  navigateMock.mockClear();
  ensureMainWindowVisibleMock.mockClear();
  sentryBreadcrumbMock.mockClear();
  toastSuccessMock.mockClear();
  // Module-level one-shot flag; drain so a prior test's focus request can't
  // satisfy this test's assertion.
  consumePendingComposerFocus();
  // A first-ever voice entry gets the preferences card instead of a session
  // (see `voice-entry-guards`); these tests are about the links, not that
  // interception, so they run as a user who has entered voice before.
  useVoicePrefsStore.setState({ firstRunSeen: true });
  resetStores();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  __resetPendingDeepLinkForTesting();
  __resetConnectDialogForTesting();
  resetStores();
});

describe("deeplink.send", () => {
  test("navigates to /assistant + parks the message in the pending store + ensures window", () => {
    renderConsumer();

    act(() => {
      publish("deeplink.send", { message: "hi" });
    });

    expect(navigateMock).toHaveBeenCalledWith("/assistant");
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      "hi",
    );
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });
});

describe("deeplink.openThread", () => {
  test("navigates to the conversation route + ensures window", () => {
    renderConsumer();

    act(() => {
      publish("deeplink.openThread", { threadId: "abc-123" });
    });

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/abc-123",
    );
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("keeps a loaded app in the side-by-side layout so the thread is visible beside it", () => {
    const restoreViewport = stubViewportAxes({
      narrow: false,
      coarsePointer: false,
    });
    useViewerStore.setState({
      mainView: "app",
      activeAppId: "app-1",
      openedAppState: { appId: "app-1", name: "My App", html: "<h1>hi</h1>" },
    });
    renderConsumer();

    try {
      act(() => {
        publish("deeplink.openThread", { threadId: "abc-123" });
      });

      expect(useViewerStore.getState().mainView).toBe("app-editing");
      expect(useConversationStore.getState().editingConversationId).toBe(
        "abc-123",
      );
      expect(navigateMock).toHaveBeenCalledWith(
        "/assistant/conversations/abc-123",
      );
    } finally {
      restoreViewport();
    }
  });

  test("resets the main view to chat so the thread isn't hidden behind the app viewer", () => {
    useViewerStore.setState({ mainView: "app" });
    renderConsumer();

    act(() => {
      publish("deeplink.openThread", { threadId: "abc-123" });
    });

    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/abc-123",
    );
  });

  test("runs the full conversation-switch path — subagent/workflow resets + active id sync", () => {
    useSubagentStore.setState({ orderedIds: ["sub-1"] });
    useWorkflowStore.setState({ orderedIds: ["wf-1"] });
    useConversationStore.setState({ activeConversationId: "old-conversation" });
    renderConsumer();

    act(() => {
      publish("deeplink.openThread", { threadId: "abc-123" });
    });

    expect(useSubagentStore.getState().orderedIds).toEqual([]);
    expect(useWorkflowStore.getState().orderedIds).toEqual([]);
    expect(useConversationStore.getState().activeConversationId).toBe(
      "abc-123",
    );
  });

  test("same-thread tap keeps live subagent/workflow state — the id doesn't change, so re-seed effects wouldn't re-run", () => {
    useSubagentStore.setState({ orderedIds: ["sub-1"] });
    useWorkflowStore.setState({ orderedIds: ["wf-1"] });
    useConversationStore.setState({ activeConversationId: "abc-123" });
    useViewerStore.setState({ mainView: "app" });
    renderConsumer();

    act(() => {
      publish("deeplink.openThread", { threadId: "abc-123" });
    });

    expect(useSubagentStore.getState().orderedIds).toEqual(["sub-1"]);
    expect(useWorkflowStore.getState().orderedIds).toEqual(["wf-1"]);
    // Viewer reset + URL sync + window activation still apply.
    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/abc-123",
    );
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });
});

describe("deeplink.sendToThread", () => {
  test("navigates to the target thread, parks the message, and requests composer focus", () => {
    renderConsumer();

    act(() => {
      publish("deeplink.sendToThread", {
        threadId: "abc-123",
        message: "gym done",
        provenance: null,
      });
    });

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/abc-123",
    );
    // Parked, never auto-sent: a custom-scheme link carries no caller
    // identity, so the send stays with the user (one tap, message staged).
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      "gym done",
    );
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("runs the conversation-switch path when targeting another thread", () => {
    useSubagentStore.setState({ orderedIds: ["sub-1"] });
    useConversationStore.setState({ activeConversationId: "old-conversation" });
    renderConsumer();

    act(() => {
      publish("deeplink.sendToThread", {
        threadId: "abc-123",
        message: "gym done",
        provenance: null,
      });
    });

    expect(useSubagentStore.getState().orderedIds).toEqual([]);
    expect(useConversationStore.getState().activeConversationId).toBe(
      "abc-123",
    );
  });

  test("same-thread delivery keeps live state and still parks the message", () => {
    useSubagentStore.setState({ orderedIds: ["sub-1"] });
    useConversationStore.setState({ activeConversationId: "abc-123" });
    renderConsumer();

    act(() => {
      publish("deeplink.sendToThread", {
        threadId: "abc-123",
        message: "gym done",
        provenance: null,
      });
    });

    expect(useSubagentStore.getState().orderedIds).toEqual(["sub-1"]);
    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/abc-123",
    );
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      "gym done",
    );
  });
});

describe("deeplink.sendToThread with proven provenance", () => {
  test("parks a send request (not a pre-fill) and navigates to the thread", () => {
    renderConsumer();

    act(() => {
      publish("deeplink.sendToThread", {
        threadId: "abc-123",
        message: "gym done",
        provenance: "intent",
      });
    });

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/abc-123",
    );
    // The chat domain fulfils this once the target is confirmed to exist;
    // nothing is sent from the global consumer, and nothing is pre-filled.
    const parked = usePendingDeepLinkStore.getState().pendingThreadSend;
    expect(parked?.threadId).toBe("abc-123");
    expect(parked?.message).toBe("gym done");
    expect(
      usePendingDeepLinkStore.getState().pendingComposerMessage,
    ).toBeNull();
    // Focus is the pre-fill contract's affordance; a send request has no
    // composer to focus yet.
    expect(consumePendingComposerFocus()).toBe(false);
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("a newer proven request replaces an older parked one", () => {
    renderConsumer();

    act(() => {
      publish("deeplink.sendToThread", {
        threadId: "abc-123",
        message: "first",
        provenance: "intent",
      });
      publish("deeplink.sendToThread", {
        threadId: "def-456",
        message: "second",
        provenance: "intent",
      });
    });

    const parked = usePendingDeepLinkStore.getState().pendingThreadSend;
    expect(parked?.threadId).toBe("def-456");
    expect(parked?.message).toBe("second");
  });
});

describe("deeplink.billingCheckoutComplete", () => {
  test("subscription success navigates to billing carrying the session id so the wizard opens", () => {
    renderConsumer();

    act(() => {
      publish("deeplink.billingCheckoutComplete", {
        status: "success",
        sessionId: "cs_test_a1B2",
        flow: "subscription",
      });
    });

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/settings/usage?tab=billing&session_id=cs_test_a1B2",
    );
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("subscription cancel lands on the upgrade-cancel page: no session id, no wizard", () => {
    renderConsumer();

    act(() => {
      publish("deeplink.billingCheckoutComplete", {
        status: "cancel",
        sessionId: null,
        flow: "subscription",
      });
    });

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/settings/billing/upgrade/cancel",
    );
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("top_up success toasts + refetches the billing summary, with no forced navigation", () => {
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");
    renderConsumer();

    act(() => {
      publish("deeplink.billingCheckoutComplete", {
        status: "success",
        sessionId: "cs_test_a1B2",
        flow: "top_up",
      });
    });

    // Same copy the web return path's `BillingStatusHandler` toasts.
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Payment received! Your credit balance will update shortly.",
      { id: "billing-status" },
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: organizationsBillingSummaryRetrieveOptions().queryKey,
    });
    // The user stays wherever they were: a top-up has no wizard to open.
    expect(navigateMock).not.toHaveBeenCalled();
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("top_up cancel lands on billing with billing_status=cancel, the offer flow's single owner", () => {
    renderConsumer();

    act(() => {
      publish("deeplink.billingCheckoutComplete", {
        status: "cancel",
        sessionId: null,
        flow: "top_up",
      });
    });

    // `usageBilling` already carries `?tab=billing`, so the param appends
    // with `&`: the exact query `BillingStatusHandler` consumes to run the
    // server-verified checkout-bonus offer flow.
    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/settings/usage?tab=billing&billing_status=cancel",
    );
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });
});

describe("deeplink.startVoice", () => {
  /** The drain awaits `whenAssistantVersionKnown`, so let microtasks settle. */
  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  /**
   * The real room predicate, evaluated at wherever the consumer just
   * navigated (`navigateMock` advances the mocked location).
   *
   * `useIsVoiceRoomVisible` is what decides room-vs-title-bar-pill, so this is
   * the assertion the whole resume path exists to satisfy: a resume that
   * navigates must land somewhere the room actually renders. Asserting the
   * navigation target alone would pass while the user stares at a pill.
   */
  const isVoiceRoomVisible = (): boolean =>
    renderHook(() => useIsVoiceRoomVisible()).result.current;

  test("mode=new starts a session on the draft composer — no conversation, so the server assigns one", async () => {
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "new",
        prompt: null,
        provenance: null,
      });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith("/assistant");
    expect(starter).toHaveBeenCalledWith("assistant-1", null);
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("parks the request when no controller is mounted, and the drain starts it once a starter registers (cold launch)", async () => {
    seedEligibleAssistant();
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "new",
        prompt: null,
        provenance: null,
      });
    });
    await flush();

    // No starter yet — the request survives rather than being dropped.
    expect(
      usePendingDeepLinkStore.getState().pendingVoiceStartAt,
    ).not.toBeNull();
    expect(navigateMock).toHaveBeenCalledWith("/assistant");

    // What `useLiveVoiceSessionController` does when it mounts.
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    await act(async () => {
      await drainPendingVoiceStart();
    });

    expect(starter).toHaveBeenCalledWith("assistant-1", null);
    expect(usePendingDeepLinkStore.getState().pendingVoiceStartAt).toBeNull();
  });

  test("navigates but does not start when the assistant can't serve live voice", async () => {
    // Below `useSupportsLiveVoice`'s MIN_VERSION — the gate that replaced the
    // retired `voice-mode` flag, and the same one that hides the composer's
    // voice button.
    seedEligibleAssistant("0.10.11");
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "new",
        prompt: null,
        provenance: null,
      });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith("/assistant");
    expect(starter).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingVoiceStartAt).toBeNull();
  });

  test("mode=resume returns to the running session's conversation instead of starting a second one", async () => {
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    useLiveVoiceStore.getState().setState("listening");
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-9");
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "resume",
        prompt: null,
        provenance: null,
      });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/conv-9",
    );
    expect(starter).not.toHaveBeenCalled();
    expect(isVoiceRoomVisible()).toBe(true);
  });

  test("mode=resume un-minimizes the room — the island tap is what the room exists to answer", async () => {
    // The real Live Activity flow: minimize the room to keep browsing, lock the
    // phone, tap the island. `useIsVoiceRoomVisible` gates on `!roomMinimized`,
    // so without an explicit restore the tap lands on the composer's voice bar
    // and visibly does nothing — and on this same-conversation path the
    // navigation is a no-op, so *nothing* on screen changes.
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    useLiveVoiceStore.getState().setState("listening");
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-9");
    useLiveVoiceStore.getState().setRoomMinimized(true);
    mockPathname = routes.conversation("conv-9");
    renderConsumer();
    expect(isVoiceRoomVisible()).toBe(false);

    act(() => {
      publish("deeplink.startVoice", {
        mode: "resume",
        prompt: null,
        provenance: null,
      });
    });
    await flush();

    expect(useLiveVoiceStore.getState().roomMinimized).toBe(false);
    expect(isVoiceRoomVisible()).toBe(true);
    expect(starter).not.toHaveBeenCalled();
  });

  test("mode=new during a live call also un-minimizes — the Action Button mid-call surfaces the room too", async () => {
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    useLiveVoiceStore.getState().setState("listening");
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-9");
    useLiveVoiceStore.getState().setRoomMinimized(true);
    mockPathname = routes.conversation("conv-9");
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "new",
        prompt: null,
        provenance: null,
      });
    });
    await flush();

    expect(useLiveVoiceStore.getState().roomMinimized).toBe(false);
    expect(isVoiceRoomVisible()).toBe(true);
  });

  test("a start-voice link with nothing running leaves the room flag alone — no session to restore", async () => {
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "resume",
        prompt: null,
        provenance: null,
      });
    });
    await flush();

    // `restoreVoiceRoom` no-ops with no active session, so the fresh session
    // the starter opens is not pre-emptively un-minimized by this path.
    expect(useLiveVoiceStore.getState().roomMinimized).toBe(false);
    expect(starter).toHaveBeenCalledWith("assistant-1", null);
  });

  test("mode=new during a live call surfaces that call instead of navigating away and starting nothing", async () => {
    // The Action Button and the Control Center control both send `mode=new`,
    // and a user can press either mid-call. The starter returns early for any
    // active phase, so falling through to it would land on the draft composer
    // — away from the conversation that owns the live session — and start
    // nothing at all, which reads as the command being broken.
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    useLiveVoiceStore.getState().setState("listening");
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-9");
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "new",
        prompt: null,
        provenance: null,
      });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/conv-9",
    );
    expect(navigateMock).not.toHaveBeenCalledWith("/assistant");
    expect(starter).not.toHaveBeenCalled();
    expect(isVoiceRoomVisible()).toBe(true);
  });

  test("mode=resume with nothing running falls through to a new session", async () => {
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "resume",
        prompt: null,
        provenance: null,
      });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith("/assistant");
    expect(starter).toHaveBeenCalledWith("assistant-1", null);
  });

  // -------------------------------------------------------------------------
  // The island tap: `mode=resume` must land on the composer that OWNS the
  // session, or the room stays hidden and the user gets the title-bar pill on
  // some unrelated chat instead of the room they tapped into.
  //
  // Ownership (`isLiveVoiceSessionOwnedBy`) accepts either the session's
  // `startedConversationId` or its server-assigned `conversationId`, so each
  // case below asserts the *predicate*, not just the navigation target.
  // -------------------------------------------------------------------------

  test("mode=resume prefers startedConversationId — the id the owning composer is bound to", async () => {
    // A composer-started session: the composer passed its routing-truth id (a
    // client-side draft id) and the server republished its own on `ready`.
    // `startedConversationId` is the one still on screen.
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    useLiveVoiceStore.getState().setState("listening");
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "draft-1");
    useLiveVoiceStore.getState().setConversationId("conv-7");
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "resume",
        prompt: null,
        provenance: null,
      });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/draft-1",
    );
    expect(starter).not.toHaveBeenCalled();
    expect(isVoiceRoomVisible()).toBe(true);
  });

  test("mode=resume falls back to conversationId for a session started without one", async () => {
    // The `mode=new` deep-link shape: started with `null`, so the server's
    // `ready` id is the only conversation there is.
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    useLiveVoiceStore.getState().setState("listening");
    useLiveVoiceStore.getState().setSessionContext("assistant-1", null);
    useLiveVoiceStore.getState().setConversationId("conv-7");
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "resume",
        prompt: null,
        provenance: null,
      });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/conv-7",
    );
    expect(starter).not.toHaveBeenCalled();
    expect(isVoiceRoomVisible()).toBe(true);
  });

  test("mode=resume falls back to /assistant when the session has no conversation at all", async () => {
    // Pre-`ready` window of a deep-link-started session: both ids are still
    // `null`, so the draft composer — bound to no conversation — owns it.
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    useLiveVoiceStore.getState().setState("connecting");
    useLiveVoiceStore.getState().setSessionContext("assistant-1", null);
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "resume",
        prompt: null,
        provenance: null,
      });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith("/assistant");
    expect(starter).not.toHaveBeenCalled();
    expect(useConversationStore.getState().activeConversationId).toBe(null);
    expect(isVoiceRoomVisible()).toBe(true);
  });

  test("tapping the island for a killed app starts a fresh session instead of an empty room", async () => {
    // Force-quit: the Live Activity outlives the session it described, so the
    // tap arrives with an idle store. Degrading to `new` is the only sane
    // landing — resuming would show a room with nothing behind it.
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    renderConsumer();

    // Nothing survived the force-quit — the branch condition the tap hits.
    expect(useLiveVoiceStore.getState().state).toBe("idle");

    act(() => {
      publish("deeplink.startVoice", {
        mode: "resume",
        prompt: null,
        provenance: null,
      });
    });
    await flush();

    expect(starter).toHaveBeenCalledWith("assistant-1", null);
    // No session yet, so no room — the room appears once the starter's session
    // reaches an active phase, exactly as it does for a `mode=new` link.
    expect(isVoiceRoomVisible()).toBe(false);
  });

  test("a prompt with nothing running pre-fills the composer and starts no session", async () => {
    // Both constraints documented on the hook: a session could not hear the
    // question (no text-turn frame), and the unauthenticated URL scheme means
    // the text must never be auto-sent, only surfaced for the user to send.
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "new",
        prompt: "what's on my calendar?",
        provenance: null,
      });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith("/assistant");
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      "what's on my calendar?",
    );
    // One tap from sent: the composer is asked to focus so the keyboard is up.
    expect(consumePendingComposerFocus()).toBe(true);
    // No voice session and no parked voice start: the room would hide the
    // pre-fill and the session could not consume it.
    expect(starter).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingVoiceStartAt).toBeNull();
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("a PROVEN prompt with nothing running is asked as a text turn in a fresh conversation", async () => {
    // Provenance is the one thing that changes the answer to "may this text
    // be sent?": the shell vouched that an App Intent produced the link on
    // the user's own action. Still no voice session, for the protocol
    // reason documented on the hook.
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "new",
        prompt: "what's on my calendar?",
        provenance: "intent",
      });
    });
    await flush();

    // `navigateToNewConversation` mints a registered draft and rides the
    // `?prompt=` auto-send: the pathway quick input uses, so no target
    // question arises and nothing is parked for the user to send by hand.
    const [to] = navigateMock.mock.calls.at(-1) as [string];
    const [path, query] = to.split("?");
    expect(path).toMatch(/^\/assistant\/conversations\/[^/]+$/);
    expect(new URLSearchParams(query).get("prompt")).toBe(
      "what's on my calendar?",
    );
    const draftId = path!.split("/").at(-1)!;
    expect(
      useConversationStore.getState().draftConversationIds.has(draftId),
    ).toBe(true);
    expect(
      usePendingDeepLinkStore.getState().pendingComposerMessage,
    ).toBeNull();
    expect(starter).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingVoiceStartAt).toBeNull();
  });

  test("a proven prompt arriving mid-call still only parks: there is no way to hand it to the session", async () => {
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    useLiveVoiceStore.getState().setState("listening");
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-9");
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "new",
        prompt: "and what about tomorrow?",
        provenance: "intent",
      });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/conv-9",
    );
    expect(starter).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      "and what about tomorrow?",
    );
  });

  test("the prompt is surfaced even when the assistant can't serve live voice", async () => {
    // The pre-fill has no live-voice version gate: an assistant too old for
    // voice still gets the question into the composer.
    seedEligibleAssistant("0.10.11");
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "new",
        prompt: "still works?",
        provenance: null,
      });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith("/assistant");
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      "still works?",
    );
    expect(starter).not.toHaveBeenCalled();
  });

  test("a null prompt behaves identically to a plain mode=new link", async () => {
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "new",
        prompt: null,
        provenance: null,
      });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith("/assistant");
    expect(starter).toHaveBeenCalledWith("assistant-1", null);
    // Nothing parked: a promptless link must not disturb the composer.
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      null,
    );
  });

  test("the prompt is delivered exactly once - re-rendering the hook does not replay it", async () => {
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    const { rerender } = renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "new",
        prompt: "ask me once",
        provenance: null,
      });
    });
    await flush();

    // The chat domain consumes and clears the one-shot inbox.
    expect(
      usePendingDeepLinkStore.getState().consumePendingComposerMessage(),
    ).toBe("ask me once");

    rerender();
    await flush();

    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      null,
    );
    expect(starter).not.toHaveBeenCalled();
    expect(navigateMock.mock.calls.length).toBe(1);
  });

  test("a prompt on a resume link that rejoins a running session is still not dropped", async () => {
    seedEligibleAssistant();
    const starter = mock((_a: string, _c: string | null) => undefined);
    useLiveVoiceStore.getState().setStarter(asStarter(starter));
    useLiveVoiceStore.getState().setState("listening");
    useLiveVoiceStore.getState().setSessionContext("assistant-1", "conv-9");
    renderConsumer();

    act(() => {
      publish("deeplink.startVoice", {
        mode: "resume",
        prompt: "and this?",
        provenance: null,
      });
    });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/conv-9",
    );
    expect(starter).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      "and this?",
    );
  });
});

describe("deeplink.connect", () => {
  test("a bundle link opens the connect dialog prefilled and navigates to the chooser", () => {
    renderConsumer();

    act(() => {
      publish("deeplink.connect", { url: null, bundle: "eyJnYXRld2F5" });
    });

    const dialog = useConnectDialogStore.getState();
    expect(dialog.open).toBe(true);
    expect(dialog.initialBundle).toBe("eyJnYXRld2F5");
    expect(dialog.guidanceMessage).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith(routes.selectAssistant);
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("a url+code QR link opens the dialog with guidance naming the host", () => {
    renderConsumer();

    act(() => {
      publish("deeplink.connect", {
        url: "https://office-mac.example:8443/assistant-1",
        bundle: null,
      });
    });

    const dialog = useConnectDialogStore.getState();
    expect(dialog.open).toBe(true);
    expect(dialog.initialBundle).toBeNull();
    expect(dialog.guidanceMessage).toBe(
      "This link came from a pairing QR code. To connect this Mac, run vellum pair on the assistant's machine at office-mac.example:8443 and paste the bundle here.",
    );
    expect(navigateMock).toHaveBeenCalledWith(routes.selectAssistant);
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("a link with no usable fields still routes to the flow with hostless guidance", () => {
    renderConsumer();

    act(() => {
      publish("deeplink.connect", { url: null, bundle: null });
    });

    const dialog = useConnectDialogStore.getState();
    expect(dialog.open).toBe(true);
    expect(dialog.guidanceMessage).toBe(
      "This link came from a pairing QR code. To connect this Mac, run vellum pair on the assistant's machine and paste the bundle here.",
    );
    expect(navigateMock).toHaveBeenCalledWith(routes.selectAssistant);
  });

  test("a bundle wins over guidance when both fields arrive", () => {
    renderConsumer();

    act(() => {
      publish("deeplink.connect", {
        url: "https://office-mac.example",
        bundle: "eyJnYXRld2F5",
      });
    });

    const dialog = useConnectDialogStore.getState();
    expect(dialog.initialBundle).toBe("eyJnYXRld2F5");
    expect(dialog.guidanceMessage).toBeNull();
  });
});

describe("deeplink.unknown", () => {
  test("Sentry breadcrumb only — no navigation or window activation", () => {
    renderConsumer();

    act(() => {
      publish("deeplink.unknown", { url: "javascript:alert(1)" });
    });

    expect(sentryBreadcrumbMock).toHaveBeenCalled();
    const args = sentryBreadcrumbMock.mock.calls[0]?.[0] as {
      data?: { url?: string };
    };
    expect(args.data?.url).toBe("javascript:alert(1)");
    expect(navigateMock).not.toHaveBeenCalled();
    expect(ensureMainWindowVisibleMock).not.toHaveBeenCalled();
  });
});

describe("subscription lifecycle", () => {
  test("unmount unsubscribes — published events after unmount have no effect", () => {
    const { unmount } = renderConsumer();

    unmount();

    act(() => {
      publish("deeplink.send", { message: "post-unmount" });
      publish("deeplink.openThread", { threadId: "z" });
      publish("deeplink.startVoice", {
        mode: "new",
        prompt: null,
        provenance: null,
      });
      publish("deeplink.connect", { url: null, bundle: "eyJnYXRld2F5" });
      publish("deeplink.unknown", { url: "x" });
    });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(useConnectDialogStore.getState().open).toBe(false);
    expect(sentryBreadcrumbMock).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      null,
    );
    expect(usePendingDeepLinkStore.getState().pendingVoiceStartAt).toBeNull();
  });
});
