/**
 * The room/pill complement for a session started from outside the composer.
 *
 * A `<scheme>://voice` link (widget button, Siri, the Action Button) starts
 * its session through `drainPendingVoiceStart`, with no composer involved in
 * the press. The user still expects the full-screen room, and the room only
 * renders for a session the on-screen composer owns, so the binding the drain
 * chooses is what decides between the room and the title-bar pill standing in
 * for it. That end-to-end path is asserted here rather than in
 * `start-voice-request.test.ts`, which sees the starter argument but not what
 * renders because of it.
 *
 * Mocked: the router (mutable pathname), `useIsMobile`, the pill's avatar hook
 * and navigation util (heavy dependency graphs), and the two live-voice
 * preflight seams the drain awaits.
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";

import { cleanup, render, renderHook } from "@testing-library/react";

import { routes } from "@/utils/routes";

const utils = await import("@/lib/backwards-compat/utils");
const whenAssistantVersionKnown = mock(() => Promise.resolve());
mock.module("@/lib/backwards-compat/utils", () => ({
  ...utils,
  whenAssistantVersionKnown,
}));

mock.module("@/runtime/main-window", () => ({
  ensureMainWindowVisible: () => Promise.resolve(),
}));

const preflightLiveVoice = mock(async () => ({ status: "ready" }));
mock.module("@/domains/chat/voice/live-voice/live-voice-preflight-api", () => ({
  preflightLiveVoice,
}));

/**
 * Location the app is "on", advanced by the drain's own navigation. The room
 * predicate reads `useLocation` to decide whether a composer is on screen, so
 * driving it from `navigateFn` is what makes this an end-to-end assertion: the
 * drain has to land somewhere the room actually renders.
 */
let mockPathname: string = routes.assistant;
const navigateFn = mock((to: string) => {
  mockPathname = to.split("?")[0] ?? to;
});
mock.module("react-router", () => ({
  useLocation: () => ({ pathname: mockPathname, search: "" }),
  useNavigate: () => navigateFn,
}));

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => false,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

let mintedDraftCount = 0;
mock.module("@/utils/conversation-navigation", () => ({
  navigateToConversation: () => {},
  // What the draft mint calls to bring the chat on screen. Stood in with the
  // plain reveal the real one falls through to, since no app is open here.
  revealConversationView: () => {
    useViewerStore.getState().setMainView("chat");
  },
  // The mint's fresh-surface preparation, stood in with the parts this
  // harness observes: a fresh key, selected and brought on screen. The
  // process-store resets the real one performs have no readers here.
  prepareFreshConversation: () => {
    mintedDraftCount += 1;
    const draftId = `voice-draft-${mintedDraftCount}`;
    useViewerStore.getState().setMainView("chat");
    useConversationStore.getState().setActiveConversationId(draftId);
    return draftId;
  },
}));

mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    components: null,
    traits: null,
    customImageUrl: null,
    isLoading: false,
    invalidate: () => {},
  }),
}));

// Imported after the mocks so every module below picks them up.
const { requestVoiceStart } =
  await import("@/domains/chat/voice/live-voice/start-voice-request");
const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const { useIsVoiceRoomVisible } =
  await import("@/domains/chat/voice/voice-room/use-is-voice-room-visible");
const { VoiceSessionPillHost } =
  await import("@/domains/chat/components/voice-session-pill-host");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");
const { __resetPendingDeepLinkForTesting } =
  await import("@/stores/pending-deep-link-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useViewerStore } = await import("@/stores/viewer-store");
const { useVoicePrefsStore } = await import("@/stores/voice-prefs-store");

/** An earlier thread the app was left sitting on when the link arrives. */
const PRIOR_CONVERSATION_ID = "conv-prior";

/** The controller's starter, binding the session as `useLiveVoice` does. */
function registerStarter(): void {
  useLiveVoiceStore.getState().setStarter({
    prewarm: () => {},
    cancelPrewarm: () => {},
    start: (assistantId, conversationId) => {
      useLiveVoiceStore
        .getState()
        .setSessionContext(assistantId, conversationId ?? null);
      useLiveVoiceStore.getState().setState("listening");
    },
  });
}

/** Let the fire-and-forget drain run to completion. */
async function flushDrain(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  mockPathname = routes.conversation(PRIOR_CONVERSATION_ID);
  navigateFn.mockClear();
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore.getState().setStarter(null);
  __resetPendingDeepLinkForTesting();
  useConversationStore.getState().reset();
  useViewerStore.getState().setMainView("chat");
  useAssistantIdentityStore.setState({
    assistantId: "assistant-1",
    version: "0.10.12",
    name: "Ada",
  });
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  useVoicePrefsStore.setState({ firstRunSeen: true });
});

afterEach(() => {
  cleanup();
  useLiveVoiceStore.getState().reset();
  useConversationStore.getState().reset();
});

test("a deep-link start opens the room on the conversation it mints, not the pill", async () => {
  // The app was left on an earlier thread, which is the state a widget button
  // or a Siri shortcut finds. The call belongs to neither that thread nor to
  // nothing at all: it gets one of its own, and the composer for it has to be
  // the one on screen or the room never opens.
  useConversationStore
    .getState()
    .setActiveConversationId(PRIOR_CONVERSATION_ID);
  registerStarter();

  requestVoiceStart(navigateFn);
  await flushDrain();

  const draftId = useConversationStore.getState().activeConversationId;
  expect(draftId).not.toBe(PRIOR_CONVERSATION_ID);
  expect(mockPathname).toBe(routes.conversation(draftId ?? ""));

  const { result } = renderHook(() => useIsVoiceRoomVisible());
  expect(result.current).toBe(true);

  // The room and the pill are exact complements: with the room up, the
  // title-bar pill renders nothing.
  const { container } = render(<VoiceSessionPillHost />);
  expect(container.firstChild).toBeNull();
});
