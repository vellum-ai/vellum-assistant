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
 * `whenAssistantVersionKnown` is stubbed (the rest of `backwards-compat/utils`
 * is the real thing, so the eligibility gate still reads real store state) —
 * the interesting cases are all about *when* it settles, including its 5s
 * timeout.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const utils = await import("@/lib/backwards-compat/utils");

let versionResolution: Promise<void> = Promise.resolve();
const whenAssistantVersionKnown = mock(() => versionResolution);

const ensureMainWindowVisibleMock = mock(() => Promise.resolve());
mock.module("@/runtime/main-window", () => ({
  ensureMainWindowVisible: ensureMainWindowVisibleMock,
}));

mock.module("@/lib/backwards-compat/utils", () => ({
  ...utils,
  whenAssistantVersionKnown,
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
const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");
const { __resetPendingDeepLinkForTesting, usePendingDeepLinkStore } =
  await import("@/stores/pending-deep-link-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { useVoicePrefsStore } = await import("@/stores/voice-prefs-store");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** New enough to serve `POST /v1/live-voice/preflight`. */
const SUPPORTED_VERSION = "0.10.12";

const starter = mock(
  (_assistantId: string, _conversationId: string | null) => undefined,
);

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
  starter.mockClear();
  whenAssistantVersionKnown.mockClear();
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

    requestVoiceStart();
    await flushDrain();

    // `null` conversation is the supported "new conversation" start — the
    // server assigns one and echoes it on `ready`.
    expect(starter).toHaveBeenCalledWith("assistant-1", null);
    expect(isParked()).toBe(false);
  });

  test("a cold-launch request waits for the controller, then starts", async () => {
    identityHydrated();

    // No `ChatLayout` yet: the drain no-ops and the request stays parked.
    requestVoiceStart();
    await Promise.resolve();
    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(true);

    // The controller mounts and drains, exactly as it does on registration.
    registerStarter();
    await drainPendingVoiceStart();

    expect(starter).toHaveBeenCalledWith("assistant-1", null);
    expect(isParked()).toBe(false);
  });

  test("draining with nothing parked never touches the version gate", async () => {
    identityHydrated();
    registerStarter();

    await drainPendingVoiceStart();

    expect(whenAssistantVersionKnown).not.toHaveBeenCalled();
    expect(starter).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// What must NOT drop the request
// ---------------------------------------------------------------------------

describe("a request that cannot be served yet stays parked", () => {
  test("the version resolution times out with the version still unknown", async () => {
    // A cold Siri / Action-Button launch against a hibernating assistant: the
    // identity fetch has not landed, so `whenAssistantVersionKnown` resolves on
    // its 5s timeout with `version` still null. The eligibility gate would read
    // the conservative `false` and throw the command away.
    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
    registerStarter();

    requestVoiceStart();
    await drainPendingVoiceStart();

    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(true);

    // The identity lands and the next drain runs it.
    identityHydrated();
    await drainPendingVoiceStart();
    expect(starter).toHaveBeenCalledWith("assistant-1", null);
  });

  test("the controller unmounts across the version await", async () => {
    identityHydrated();
    registerStarter();

    let hydrate = (): void => undefined;
    versionResolution = new Promise<void>((resolve) => {
      hydrate = resolve;
    });

    usePendingDeepLinkStore.getState().setPendingVoiceStart();
    const drained = drainPendingVoiceStart();
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
    await drainPendingVoiceStart();
    expect(starter).toHaveBeenCalledWith("assistant-1", null);
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

    requestVoiceStart();
    await drainPendingVoiceStart();

    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(false);
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
    await drainPendingVoiceStart();

    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(false);
  });

  test("a park inside its TTL still starts", async () => {
    identityHydrated();
    registerStarter();

    usePendingDeepLinkStore.setState({
      pendingVoiceStartAt: Date.now() - PENDING_VOICE_START_TTL_MS + 5_000,
    });
    await drainPendingVoiceStart();

    expect(starter).toHaveBeenCalledWith("assistant-1", null);
  });
});

// ---------------------------------------------------------------------------
// Exactly-once
// ---------------------------------------------------------------------------

describe("one-shot delivery", () => {
  test("repeat drains after a start are free", async () => {
    identityHydrated();
    registerStarter();

    requestVoiceStart();
    await drainPendingVoiceStart();
    await drainPendingVoiceStart();
    await drainPendingVoiceStart();

    expect(starter).toHaveBeenCalledTimes(1);
  });

  test("two links before a drain are one request", async () => {
    identityHydrated();

    requestVoiceStart();
    requestVoiceStart();
    await Promise.resolve();

    registerStarter();
    await drainPendingVoiceStart();

    expect(starter).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The shared surface entry
// ---------------------------------------------------------------------------

describe("startVoiceFromSurface", () => {
  test("navigates to the draft composer and parks the request", () => {
    identityHydrated();
    const navigate = mock((_to: string) => undefined);

    startVoiceFromSurface(navigate);

    // The draft route, not the open conversation: the session starts with no
    // conversation and the server assigns one on `ready`. Navigating is also
    // what mounts the layout that owns the starter.
    expect(navigate).toHaveBeenCalledWith("/assistant");
    expect(isParked()).toBe(true);
  });

  test("starts once the starter registers, which is the press that used to be lost", async () => {
    // The press lands where no chat layout is mounted, so nothing can serve it
    // yet. It must survive until one does rather than being spent on arrival.
    identityHydrated();
    const navigate = mock((_to: string) => undefined);

    startVoiceFromSurface(navigate);
    await Promise.resolve();
    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(true);

    registerStarter();
    await drainPendingVoiceStart();

    expect(starter).toHaveBeenCalledWith("assistant-1", null);
  });

  test("a running session spends the press", () => {
    identityHydrated();
    registerStarter();
    useLiveVoiceStore.getState().setState("listening");
    const navigate = mock((_to: string) => undefined);

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

    requestVoiceStart();
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

    requestVoiceStart();
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

    requestVoiceStart();
    await Promise.resolve();
    await Promise.resolve();

    expect(ensureMainWindowVisibleMock).not.toHaveBeenCalled();
  });

  test("an unconfigured assistant gets the notice, not a room that opens and closes", async () => {
    identityHydrated();
    registerStarter();
    preflightVerdict = { status: "not-ready", userMessage: "Set up a voice." };

    requestVoiceStart();
    await drainPendingVoiceStart();

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

    requestVoiceStart();
    await drainPendingVoiceStart();

    expect(starter).toHaveBeenCalledWith("assistant-1", null);
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

    const drain = drainPendingVoiceStart();
    await Promise.resolve();
    await Promise.resolve();
    useLiveVoiceStore.getState().setStarter(null);
    released();
    await drain;

    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(true);
  });
});
