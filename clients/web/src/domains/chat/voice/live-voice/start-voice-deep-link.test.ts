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

mock.module("@/lib/backwards-compat/utils", () => ({
  ...utils,
  whenAssistantVersionKnown,
}));

const {
  PENDING_VOICE_START_TTL_MS,
  drainPendingVoiceStartDeepLink,
  requestVoiceStartFromDeepLink,
} = await import("@/domains/chat/voice/live-voice/start-voice-deep-link");
const { useLiveVoiceStore } = await import(
  "@/domains/chat/voice/live-voice/live-voice-store"
);
const { useAssistantIdentityStore } = await import(
  "@/stores/assistant-identity-store"
);
const { __resetPendingDeepLinkForTesting, usePendingDeepLinkStore } =
  await import("@/stores/pending-deep-link-store");
const { useResolvedAssistantsStore } = await import(
  "@/stores/resolved-assistants-store"
);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** New enough to serve `POST /v1/live-voice/preflight`. */
const SUPPORTED_VERSION = "0.10.12";

const starter = mock((_assistantId: string, _conversationId: string | null) =>
  undefined,
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
  versionResolution = Promise.resolve();
});

// ---------------------------------------------------------------------------
// The happy paths
// ---------------------------------------------------------------------------

describe("starting a session", () => {
  test("a warm request parks and starts in one call", async () => {
    identityHydrated();
    registerStarter();

    requestVoiceStartFromDeepLink();
    await Promise.resolve();
    await Promise.resolve();

    // `null` conversation is the supported "new conversation" start — the
    // server assigns one and echoes it on `ready`.
    expect(starter).toHaveBeenCalledWith("assistant-1", null);
    expect(isParked()).toBe(false);
  });

  test("a cold-launch request waits for the controller, then starts", async () => {
    identityHydrated();

    // No `ChatLayout` yet: the drain no-ops and the request stays parked.
    requestVoiceStartFromDeepLink();
    await Promise.resolve();
    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(true);

    // The controller mounts and drains, exactly as it does on registration.
    registerStarter();
    await drainPendingVoiceStartDeepLink();

    expect(starter).toHaveBeenCalledWith("assistant-1", null);
    expect(isParked()).toBe(false);
  });

  test("draining with nothing parked never touches the version gate", async () => {
    identityHydrated();
    registerStarter();

    await drainPendingVoiceStartDeepLink();

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

    requestVoiceStartFromDeepLink();
    await drainPendingVoiceStartDeepLink();

    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(true);

    // The identity lands and the next drain runs it.
    identityHydrated();
    await drainPendingVoiceStartDeepLink();
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
    const drained = drainPendingVoiceStartDeepLink();
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
    await drainPendingVoiceStartDeepLink();
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

    requestVoiceStartFromDeepLink();
    await drainPendingVoiceStartDeepLink();

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
    await drainPendingVoiceStartDeepLink();

    expect(starter).not.toHaveBeenCalled();
    expect(isParked()).toBe(false);
  });

  test("a park inside its TTL still starts", async () => {
    identityHydrated();
    registerStarter();

    usePendingDeepLinkStore.setState({
      pendingVoiceStartAt: Date.now() - PENDING_VOICE_START_TTL_MS + 5_000,
    });
    await drainPendingVoiceStartDeepLink();

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

    requestVoiceStartFromDeepLink();
    await drainPendingVoiceStartDeepLink();
    await drainPendingVoiceStartDeepLink();
    await drainPendingVoiceStartDeepLink();

    expect(starter).toHaveBeenCalledTimes(1);
  });

  test("two links before a drain are one request", async () => {
    identityHydrated();

    requestVoiceStartFromDeepLink();
    requestVoiceStartFromDeepLink();
    await Promise.resolve();

    registerStarter();
    await drainPendingVoiceStartDeepLink();

    expect(starter).toHaveBeenCalledTimes(1);
  });
});
