/**
 * Tests for the start-voice deep link → live-voice session seam.
 *
 * The property under test is that a request the user actually made is never
 * silently lost. A `<scheme>://voice` link is the one voice entry point with no
 * UI behind it — nothing on screen shows that a session was asked for — so a
 * drop is invisible to the user, who just sees an app that opened and did
 * nothing. Every precondition that can still become true therefore leaves the
 * request parked for the next drain, and only a resolved decision spends it.
 *
 * `whenAssistantVersionKnownFor` is stubbed (the rest of
 * `backwards-compat/utils` is the real thing, so the eligibility gate still
 * reads real store state). The interesting cases are all about *when* it
 * settles, including its 5s timeout, and about *which* assistant it is asked
 * about: the gate it feeds is owner-scoped.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const utils = await import("@/lib/backwards-compat/utils");

let versionResolution: Promise<void> = Promise.resolve();
const whenAssistantVersionKnownFor = mock(
  (_ownerAssistantId: string | null | undefined) => versionResolution,
);

const ensureMainWindowVisibleMock = mock(() => Promise.resolve());
mock.module("@/runtime/main-window", () => ({
  ensureMainWindowVisible: ensureMainWindowVisibleMock,
}));

mock.module("@/lib/backwards-compat/utils", () => ({
  ...utils,
  whenAssistantVersionKnownFor,
}));

/**
 * Readiness is a real network call at entry time; stub it so these tests stay
 * about the parked-request plumbing. `preflightVerdict` is what the daemon
 * would answer.
 */
let preflightVerdict: { status: string; userMessage?: string } | null = {
  status: "ready",
};
const preflightLiveVoice = mock(async () => preflightVerdict);
mock.module("@/domains/chat/voice/live-voice/live-voice-preflight-api", () => ({
  preflightLiveVoice,
}));

const {
  PENDING_VOICE_START_TTL_MS,
  drainPendingVoiceStart,
  requestVoiceStart,
  startVoiceFromSurface,
} = await import("@/domains/chat/voice/live-voice/start-voice-request");
const { isLiveVoiceSessionOwnedBy, useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useViewerStore } = await import("@/stores/viewer-store");
const { __resetPendingDeepLinkForTesting, usePendingDeepLinkStore } =
  await import("@/stores/pending-deep-link-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { useVoicePrefsStore } = await import("@/stores/voice-prefs-store");
const { routes } = await import("@/utils/routes");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** New enough to serve `POST /v1/live-voice/preflight`. */
const SUPPORTED_VERSION = "0.10.12";

/**
 * The conversation the app was left sitting on. Selection survives navigation
 * and cold launches, so every start below is made with an unrelated earlier
 * thread selected: the state a widget button or a Siri shortcut actually finds.
 */
const PRIOR_CONVERSATION_ID = "conv-prior";

/** The app's navigation, which the drain uses to land on the draft it mints. */
const navigate = mock(
  (_to: string, _options?: { replace?: boolean }) => undefined,
);

/**
 * Stands in for the controller's starter, and binds the session to the
 * conversation it was handed exactly as `useLiveVoice` does at connect time.
 * Ownership is the whole point of the argument, so a spy that only records it
 * could not tell a bound session from an orphaned one.
 */
const starter = mock((assistantId: string, conversationId: string | null) => {
  useLiveVoiceStore.getState().setSessionContext(assistantId, conversationId);
  useLiveVoiceStore.getState().setState("listening");
});

function registerStarter(): void {
  useLiveVoiceStore.getState().setStarter({
    prewarm: () => {},
    cancelPrewarm: () => {},
    start: starter,
  });
}

/** An assistant that is resolved, active, and new enough for live voice. */
function identityHydrated(version: string = SUPPORTED_VERSION): void {
  useAssistantIdentityStore.setState({
    assistantId: "assistant-1",
    version,
    name: "Ada",
  });
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
}

/**
 * Let a fire-and-forget drain run to completion. `requestVoiceStart` cannot be
 * awaited by design (it is called from click handlers and command dispatch),
 * and the drain awaits both the version resolution and readiness.
 */
async function flushDrain(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

function isParked(): boolean {
  return usePendingDeepLinkStore.getState().pendingVoiceStartAt !== null;
}

/** The draft the drain minted, which is a fresh uuid rather than a literal. */
function mintedConversationId(): string {
  const draftId = useConversationStore.getState().activeConversationId;
  if (draftId === null) {
    throw new Error("expected the drain to mint a draft conversation");
  }
  return draftId;
}

/**
 * The whole binding in one assertion: the session was started on a conversation
 * minted for it rather than the one the app was left on, and the composer for
 * that conversation was navigated onto the screen so it can own the session.
 */
function expectStartedOnFreshDraft(): void {
  const draftId = mintedConversationId();
  expect(draftId).not.toBe(PRIOR_CONVERSATION_ID);
  expect(starter).toHaveBeenCalledWith("assistant-1", draftId);
  expect(navigate).toHaveBeenCalledWith(routes.conversation(draftId), {
    replace: true,
  });
}

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore.getState().setStarter(null);
  __resetPendingDeepLinkForTesting();
  useAssistantIdentityStore.setState({
    assistantId: null,
    version: null,
    name: null,
  });
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
  useConversationStore.getState().reset();
  useConversationStore
    .getState()
    .setActiveConversationId(PRIOR_CONVERSATION_ID);
  useViewerStore.getState().reset();
  useViewerStore.getState().setMainView("app");
  navigate.mockClear();
  starter.mockClear();
  whenAssistantVersionKnownFor.mockClear();
  preflightLiveVoice.mockClear();
  ensureMainWindowVisibleMock.mockClear();
  versionResolution = Promise.resolve();
  preflightVerdict = { status: "ready" };
  // These tests are about delivery, not about the first-ever entry: a user who
  // has never opened voice gets the preferences card instead of a session, and
  // that interception has its own tests below.
  useVoicePrefsStore.setState({ firstRunSeen: true });
});

// ---------------------------------------------------------------------------
// The happy paths
// ---------------------------------------------------------------------------

describe("starting a session", () => {
  test("a warm request parks and starts in one call", async () => {
    identityHydrated();
    registerStarter();

    requestVoiceStart(navigate);
    await flushDrain();

    expectStartedOnFreshDraft();
    expect(isParked()).toBe(false);
  });

  test("a cold-launch request waits for the controller, then starts", async () => {
    identityHydrated();

    // No `ChatLayout` yet: the drain no-ops and the request stays parked.
    requestVoiceStart(navigate);
    await Promise.resolve();
    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(true);

    // The controller mounts and drains, exactly as it does on registration.
    registerStarter();
    await drainPendingVoiceStart(navigate);

    expectStartedOnFreshDraft();
    expect(isParked()).toBe(false);
  });

  test("a start binds to a conversation of its own, never the one the app was left on", async () => {
    // The store's selection is wherever the user was last, which for a widget
    // button or a Siri shortcut is an unrelated conversation from another day.
    // An externally initiated start must never reuse it.
    identityHydrated();
    registerStarter();

    requestVoiceStart(navigate);
    await flushDrain();

    const draftId = mintedConversationId();
    expect(draftId).not.toBe(PRIOR_CONVERSATION_ID);
    expect(starter).not.toHaveBeenCalledWith(
      "assistant-1",
      PRIOR_CONVERSATION_ID,
    );
    expect(
      isLiveVoiceSessionOwnedBy(
        useLiveVoiceStore.getState(),
        PRIOR_CONVERSATION_ID,
      ),
    ).toBe(false);
  });

  test("the started session is owned by the composer the drain lands on", async () => {
    // A session without an owning on-screen composer cannot open the room;
    // the title-bar pill stands in for it instead.
    identityHydrated();
    registerStarter();

    requestVoiceStart(navigate);
    await flushDrain();

    const draftId = mintedConversationId();
    expect(navigate).toHaveBeenCalledWith(routes.conversation(draftId), {
      replace: true,
    });
    expect(
      isLiveVoiceSessionOwnedBy(useLiveVoiceStore.getState(), draftId),
    ).toBe(true);
  });

  test("puts the chat on screen for the draft it mints", async () => {
    // On desktop the composer counts as on screen only while the main view is
    // the chat, so a draft minted behind the app viewer owns nothing.
    identityHydrated();
    registerStarter();

    requestVoiceStart(navigate);
    await flushDrain();

    expect(useViewerStore.getState().mainView).toBe("chat");
  });

  test("leaves no side panel from the previous conversation on the fresh draft", async () => {
    // A files panel is one message's attachments, so it belongs to the thread
    // the app was left on. Carried into a conversation with no messages at all
    // it shows the new call someone else's payload.
    identityHydrated();
    registerStarter();
    useViewerStore.getState().openMessageFiles({
      messageId: "msg-prior",
      attachments: [],
    });

    requestVoiceStart(navigate);
    await flushDrain();

    expect(useViewerStore.getState().activeMessageFiles).toBeNull();
    expect(useViewerStore.getState().mainView).toBe("chat");
  });

  test("draining with nothing parked never touches the version gate", async () => {
    identityHydrated();
    registerStarter();

    await drainPendingVoiceStart(navigate);

    expect(whenAssistantVersionKnownFor).not.toHaveBeenCalled();
    expect(starter).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// What must NOT drop the request
// ---------------------------------------------------------------------------

describe("a request that cannot be served yet stays parked", () => {
  test("the version resolution times out with the version still unknown", async () => {
    // A cold Siri / Action-Button launch against a hibernating assistant: the
    // identity fetch has not landed, so the version wait resolves on its 5s
    // timeout with `version` still null. The eligibility gate would read the
    // conservative `false` and throw the command away.
    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
    registerStarter();

    requestVoiceStart(navigate);
    await drainPendingVoiceStart(navigate);

    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(true);

    // The identity lands and the next drain runs it.
    identityHydrated();
    await drainPendingVoiceStart(navigate);
    expectStartedOnFreshDraft();
  });

  test("the identity still belongs to the assistant switched away from", async () => {
    // The switch-triggered drain runs on the resolved-assistants change, and
    // that change lands before the identity store is cleared and rehydrated
    // for the assistant switched to. The eligibility gate is owner-scoped, so
    // deciding here on the version still held for the previous assistant reads
    // as "too old for live voice" and spends a press the user really made.
    identityHydrated();
    registerStarter();
    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" });

    usePendingDeepLinkStore.getState().setPendingVoiceStart();
    await drainPendingVoiceStart(navigate);

    // The version is awaited for the assistant a fresh start now means, not
    // for whichever one the identity store happens to be holding.
    expect(whenAssistantVersionKnownFor).toHaveBeenCalledWith("assistant-2");
    expect(starter).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(useConversationStore.getState().activeConversationId).toBe(
      PRIOR_CONVERSATION_ID,
    );
    expect(isParked()).toBe(true);

    // The new assistant's identity lands, and the next drain serves the press
    // on it.
    useAssistantIdentityStore.setState({
      assistantId: "assistant-2",
      version: SUPPORTED_VERSION,
      name: "Grace",
    });
    await drainPendingVoiceStart(navigate);

    const draftId = mintedConversationId();
    expect(draftId).not.toBe(PRIOR_CONVERSATION_ID);
    expect(starter).toHaveBeenCalledWith("assistant-2", draftId);
    expect(isParked()).toBe(false);
  });

  test("the controller unmounts across the version await", async () => {
    identityHydrated();
    registerStarter();

    let hydrate = (): void => undefined;
    versionResolution = new Promise<void>((resolve) => {
      hydrate = resolve;
    });

    usePendingDeepLinkStore.getState().setPendingVoiceStart();
    const drained = drainPendingVoiceStart(navigate);
    // Navigating off the chat layout mid-await: there is no starter left to
    // hand this to.
    useLiveVoiceStore.getState().setStarter(null);
    hydrate();
    await drained;

    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(true);

    // The next `ChatLayout` mount picks it up.
    versionResolution = Promise.resolve();
    registerStarter();
    await drainPendingVoiceStart(navigate);
    expectStartedOnFreshDraft();
  });
});

// ---------------------------------------------------------------------------
// What must spend the request
// ---------------------------------------------------------------------------

describe("a request that will never be served is discarded", () => {
  test("an assistant too old for live voice", async () => {
    // Same verdict the composer reaches when it renders no voice button. The
    // version is resolved, so this is a decision rather than a race — leaving
    // it parked would fire it at some unrelated later mount.
    identityHydrated("0.10.11");
    registerStarter();

    requestVoiceStart(navigate);
    await drainPendingVoiceStart(navigate);

    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(false);
    // No conversation is minted for a start that never happens, so the user is
    // not left staring at an empty new chat.
    expect(useConversationStore.getState().activeConversationId).toBe(
      PRIOR_CONVERSATION_ID,
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  test("a park older than its TTL", async () => {
    identityHydrated();
    registerStarter();

    // A park whose `navigate(routes.assistant)` was bounced by a route guard
    // (unauthenticated, mid-onboarding) is never drained at the time. It must
    // not open a full-screen voice session on some later mount.
    usePendingDeepLinkStore.setState({
      pendingVoiceStartAt: Date.now() - PENDING_VOICE_START_TTL_MS - 1,
    });
    await drainPendingVoiceStart(navigate);

    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  test("a park inside its TTL still starts", async () => {
    identityHydrated();
    registerStarter();

    usePendingDeepLinkStore.setState({
      pendingVoiceStartAt: Date.now() - PENDING_VOICE_START_TTL_MS + 5_000,
    });
    await drainPendingVoiceStart(navigate);

    expectStartedOnFreshDraft();
  });
});

// ---------------------------------------------------------------------------
// Exactly-once
// ---------------------------------------------------------------------------

describe("one-shot delivery", () => {
  test("repeat drains after a start are free", async () => {
    identityHydrated();
    registerStarter();

    requestVoiceStart(navigate);
    await drainPendingVoiceStart(navigate);
    await drainPendingVoiceStart(navigate);
    await drainPendingVoiceStart(navigate);

    expect(starter).toHaveBeenCalledTimes(1);
    // One start, so one draft: repeat drains must not mint a new conversation
    // each time they run.
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  test("two links before a drain are one request", async () => {
    identityHydrated();

    requestVoiceStart(navigate);
    requestVoiceStart(navigate);
    await Promise.resolve();

    registerStarter();
    await drainPendingVoiceStart(navigate);

    expect(starter).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The shared surface entry
// ---------------------------------------------------------------------------

describe("startVoiceFromSurface", () => {
  test("navigates to the chat and parks the request", () => {
    identityHydrated();

    startVoiceFromSurface(navigate);

    // Navigating to the chat is what mounts the layout that owns the starter;
    // the drain then mints the conversation the session binds to.
    expect(navigate).toHaveBeenCalledWith("/assistant");
    expect(isParked()).toBe(true);
  });

  test("starts once the starter registers, which is the press that used to be lost", async () => {
    // The press lands where no chat layout is mounted, so nothing can serve it
    // yet. It must survive until one does rather than being spent on arrival.
    identityHydrated();

    startVoiceFromSurface(navigate);
    await Promise.resolve();
    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(true);

    registerStarter();
    await drainPendingVoiceStart(navigate);

    // The press was made from outside the conversation the app was left on,
    // and it opens a call of its own rather than resuming that thread.
    expectStartedOnFreshDraft();
  });

  test("a running session spends the press", () => {
    identityHydrated();
    registerStarter();
    useLiveVoiceStore.getState().setState("listening");

    startVoiceFromSurface(navigate);

    // That session is the one the user is in. Navigating would only walk the
    // app away from the composer that owns it.
    expect(navigate).not.toHaveBeenCalled();
    expect(isParked()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The guards a session has to get past
// ---------------------------------------------------------------------------

describe("entry guards", () => {
  test("the first-ever entry opens the preferences card instead of a session", async () => {
    // The card is the answer to this press. Something the user can see took
    // the request, so it is spent rather than left parked for later.
    identityHydrated();
    registerStarter();
    useVoicePrefsStore.setState({ firstRunSeen: false });

    requestVoiceStart(navigate);
    await Promise.resolve();
    await Promise.resolve();

    expect(useLiveVoiceStore.getState().firstRunCardOpen).toBe(true);
    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(false);
  });

  /**
   * The card is drawn in the app's window, and the press that summoned it can
   * come from the companion surface, which deliberately never raises. Left
   * behind whatever the user is working in, the card is a question nobody can
   * see and the press reads as having done nothing.
   */
  test("the first-ever entry brings the app forward to ask its question", async () => {
    identityHydrated();
    registerStarter();
    useVoicePrefsStore.setState({ firstRunSeen: false });

    requestVoiceStart(navigate);
    await Promise.resolve();
    await Promise.resolve();

    expect(ensureMainWindowVisibleMock).toHaveBeenCalled();
  });

  /**
   * And only then. Every other entry is a surface the user reached for because
   * they are working somewhere else, so raising would take the app away from
   * them to show a call that is already on the surface they pressed.
   */
  test("an ordinary start leaves the app where it is", async () => {
    identityHydrated();
    registerStarter();
    useVoicePrefsStore.setState({ firstRunSeen: true });

    requestVoiceStart(navigate);
    await Promise.resolve();
    await Promise.resolve();

    expect(ensureMainWindowVisibleMock).not.toHaveBeenCalled();
  });

  test("an unconfigured assistant gets the notice, not a room that opens and closes", async () => {
    identityHydrated();
    registerStarter();
    preflightVerdict = { status: "not-ready", userMessage: "Set up a voice." };

    requestVoiceStart(navigate);
    await drainPendingVoiceStart(navigate);

    expect(useLiveVoiceStore.getState().configNotice).toBe("Set up a voice.");
    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(false);
  });

  test("a failed preflight starts anyway rather than blocking voice", async () => {
    // An outage on the readiness call must not be the thing that stops a user
    // talking; a real credential problem still surfaces at the handshake.
    identityHydrated();
    registerStarter();
    preflightVerdict = null;

    requestVoiceStart(navigate);
    await drainPendingVoiceStart(navigate);

    expectStartedOnFreshDraft();
    expect(useLiveVoiceStore.getState().configNotice).toBeNull();
  });

  test("a controller that unmounts during preflight leaves the request parked", async () => {
    // The one precondition here that can still become true, so this is the one
    // case that must not spend the press.
    identityHydrated();
    registerStarter();
    usePendingDeepLinkStore.getState().setPendingVoiceStart();
    let released: () => void = () => {};
    preflightLiveVoice.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          released = () => resolve({ status: "ready" });
        }),
    );

    const drain = drainPendingVoiceStart(navigate);
    await Promise.resolve();
    await Promise.resolve();
    useLiveVoiceStore.getState().setStarter(null);
    released();
    await drain;

    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The app moving on while the preflight is in flight
// ---------------------------------------------------------------------------

/**
 * The preflight is a network round trip, and the whole tail of the drain runs
 * after it: minting a conversation, navigating onto it, starting a session on
 * the assistant that was active when the drain began. A user is free to do
 * anything at all in that window, so every one of those three has to be
 * decided on state re-read afterwards rather than on what the drain captured.
 */
describe("state read before the preflight is re-read after it", () => {
  /**
   * Park a request and run the drain as far as the preflight, which is held
   * open until the returned `release` is called. Awaits the two microtasks the
   * drain needs to get there, so callers change state with it genuinely
   * in flight.
   */
  async function drainBlockedOnPreflight(): Promise<{
    drain: Promise<void>;
    release: () => void;
  }> {
    let release: () => void = () => {};
    preflightLiveVoice.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(preflightVerdict);
        }),
    );
    usePendingDeepLinkStore.getState().setPendingVoiceStart();
    const drain = drainPendingVoiceStart(navigate);
    await Promise.resolve();
    await Promise.resolve();
    return { drain, release: () => release() };
  }

  test("a session started from the composer mid-preflight spends the press", async () => {
    // The user got to the chat and pressed the voice button themselves. That
    // session is the one they are in: starting is refused anyway, and the
    // navigation would walk the app off the composer that owns it.
    identityHydrated();
    registerStarter();
    const { drain, release } = await drainBlockedOnPreflight();

    useLiveVoiceStore
      .getState()
      .setSessionContext("assistant-1", "conv-composer");
    useLiveVoiceStore.getState().setState("listening");
    release();
    await drain;

    expect(starter).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(useConversationStore.getState().activeConversationId).toBe(
      PRIOR_CONVERSATION_ID,
    );
    expect(isParked()).toBe(false);
  });

  test("an assistant switched mid-preflight leaves the request parked", async () => {
    // Both the eligibility gate and the verdict answered for the assistant the
    // user has just left, so neither authorizes a start on the one they moved
    // to. Nothing was minted or navigated, so the press survives for a drain
    // that can run both gates against whoever is active then.
    identityHydrated();
    registerStarter();
    const { drain, release } = await drainBlockedOnPreflight();

    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" });
    release();
    await drain;

    expect(starter).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(useConversationStore.getState().activeConversationId).toBe(
      PRIOR_CONVERSATION_ID,
    );
    expect(isParked()).toBe(true);

    // Back on the assistant the press was made for, the next drain serves it.
    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
    await drainPendingVoiceStart(navigate);
    expectStartedOnFreshDraft();
  });

  test("a verdict about the assistant the user left publishes no notice", async () => {
    // The notice is drawn against whatever conversation is on screen, which by
    // now belongs to another assistant, so it would read as that assistant's
    // voice being unconfigured.
    identityHydrated();
    registerStarter();
    preflightVerdict = { status: "not-ready", userMessage: "Set up a voice." };
    const { drain, release } = await drainBlockedOnPreflight();

    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" });
    release();
    await drain;

    expect(useLiveVoiceStore.getState().configNotice).toBeNull();
  });
});
