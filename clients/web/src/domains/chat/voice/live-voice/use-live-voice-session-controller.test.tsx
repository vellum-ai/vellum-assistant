/**
 * Tests for `useLiveVoiceSessionController` — the persistent (layout-mounted)
 * owner of the live-voice session controller.
 *
 * Uses the shared fakes from `live-voice-fakes.test-helper.ts` so no
 * WebSocket, microphone, or AudioContext is touched. The controller renders
 * nothing; everything is asserted through the store seams it maintains
 * (`starter`, per-session `controls`, session state).
 *
 * The load-bearing property is lifetime: consumers (composer, pill) come and
 * go with navigation while the controller stays mounted, so a session driven
 * entirely through the store must keep running until the controller itself
 * unmounts (leaving the chat layout) or `controls.stop()` fires.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { VoiceAudioInterruptionEvent } from "@/runtime/native-audio-session";

// The default client factory in use-live-voice statically imports the real
// LiveVoiceChannelClient, which pulls in connection.ts -> the generated SDK.
// Tests inject fake primitives, so we never construct the real client; mock the
// connection module so importing the controller doesn't drag in the SDK client.
mock.module("@/domains/chat/voice/live-voice/connection", () => ({
  resolveLiveVoiceWsUrl: mock(
    async () => "wss://velay.vellum.ai/a/v1/live-voice",
  ),
}));

// The iOS audio-session bridge. Stubbed at the module boundary (rather than by
// faking `isNativeIOS`) so the controller's lifecycle wiring is asserted
// directly; the bridge's own off-native/skew behavior is pinned by
// `runtime/native-audio-session.test.ts`.
type InterruptionEvent = VoiceAudioInterruptionEvent;
let onNativeAndroid = false;
let onNativeIOS = false;
const activateVoiceAudioSession = mock(async () => true);
const deactivateVoiceAudioSession = mock(async () => undefined);
const unsubscribeInterruptions = mock(() => undefined);
let interruptionHandlers: ((event: InterruptionEvent) => void)[] = [];

// A whole-module mock, so every export the controller's import graph reaches
// has to be present here or the module fails to load.
mock.module("@/runtime/native-audio-session", () => ({
  activateVoiceAudioSession,
  deactivateVoiceAudioSession,
  subscribeVoiceAudioInterruptions: (
    handler: (event: InterruptionEvent) => void,
  ) => {
    interruptionHandlers.push(handler);
    return () => {
      unsubscribeInterruptions();
      interruptionHandlers = interruptionHandlers.filter((h) => h !== handler);
    };
  },
}));

// Spread over the real module rather than listing three exports, because
// `mock.module` replaces a module *wholesale*: anything the controller's graph
// imports from here and this factory omits fails to resolve at import time, as
// a `SyntaxError` naming an export that plainly does exist. The graph grows on
// its own — the island's control handler reaching `confirmation-actions` pulled
// in `api/messages`, and with it `detectClientOs` — so enumerating exports here
// makes an unrelated import a test failure. Only the three platform predicates
// need to be steerable; the rest should behave normally.
const actualPlatformDetection = await import("@/runtime/platform-detection");

// Voice entry preflights readiness before a session opens; stub it ready so
// the controller's drain tests stay about the starter. See `voice-entry-guards`.
// A mock rather than a literal so a case can hold the round trip open and move
// the app underneath a drain, which is the only way to reach the repark.
const preflightLiveVoice = mock(async () => ({ status: "ready" }));
mock.module("@/domains/chat/voice/live-voice/live-voice-preflight-api", () => ({
  preflightLiveVoice,
}));

mock.module("@/runtime/platform-detection", () => ({
  ...actualPlatformDetection,
  isNativeAndroid: () => onNativeAndroid,
  isNativeIOS: () => onNativeIOS,
  isNativeMobile: () => onNativeAndroid || onNativeIOS,
}));

/** Deliver a native `AVAudioSession` interruption to every live subscriber. */
function emitInterruption(event: InterruptionEvent): void {
  for (const handler of interruptionHandlers) {
    handler(event);
  }
}

import type { LiveVoiceChannelClient } from "@/domains/chat/voice/live-voice/live-voice-client";
import type { LiveVoiceAudioCapture } from "@/domains/chat/voice/live-voice/pcm-capture";
import type { LiveVoiceAudioPlayer } from "@/domains/chat/voice/live-voice/tts-playback";

import {
  FakeCapture,
  FakeClient,
  FakePlayer,
} from "@/domains/chat/voice/live-voice/live-voice-fakes.test-helper";

// Imported after the connection mock so the real connection.ts never enters
// the static import graph.
const { useLiveVoiceSessionController } =
  await import("@/domains/chat/voice/live-voice/use-live-voice-session-controller");
const { useVoicePrefsStore } = await import("@/stores/voice-prefs-store");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { __resetPendingDeepLinkForTesting, usePendingDeepLinkStore } =
  await import("@/stores/pending-deep-link-store");
const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const { useConversationStore } = await import("@/stores/conversation-store");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function renderPersistentController(
  configureCapture?: (capture: FakeCapture) => void,
) {
  // One client/capture pair per started session, like the real factories.
  const clients: FakeClient[] = [];
  const captures: FakeCapture[] = [];
  const player = new FakePlayer();

  let renderCount = 0;

  // Under a router because the controller lands on the conversation a drained
  // start-voice request mints for its session, exactly as `ChatLayout` does.
  const view = renderHook(
    () => {
      renderCount += 1;
      useLiveVoiceSessionController({
        createClient: () => {
          const client = new FakeClient();
          clients.push(client);
          return client as unknown as LiveVoiceChannelClient;
        },
        createPlayer: () => player as unknown as LiveVoiceAudioPlayer,
        createCapture: (options) => {
          const capture = new FakeCapture(options);
          configureCapture?.(capture);
          captures.push(capture);
          return capture as unknown as LiveVoiceAudioCapture;
        },
      });
    },
    {
      wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
    },
  );

  return {
    view,
    player,
    clients,
    captures,
    lastClient: () => clients[clients.length - 1]!,
    lastCapture: () => captures[captures.length - 1]!,
    renderCount: () => renderCount,
  };
}

/** Start a session through the store-registered starter and reach `listening`. */
async function startListeningViaStarter(
  h: ReturnType<typeof renderPersistentController>,
  conversationId: string | null = "conv-1",
) {
  await act(async () => {
    useLiveVoiceStore.getState().starter?.start("assistant-1", conversationId);
    await Promise.resolve();
  });
  await act(async () => {
    h.lastClient().emit("ready", {
      type: "ready",
      seq: 1,
      sessionId: "s1",
      conversationId: conversationId ?? "conv-server-assigned",
      // Echo server_vad so the session stays hands-free (the controller starts
      // every session hands-free); without the echo the client falls back to
      // manual single-turn.
      turnDetection: "server_vad",
    });
    await Promise.resolve();
  });
}

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore.getState().setStarter(null);
  // The voice-prefs store is a persisted singleton shared across test files;
  // pin the turn-taking settings to unset (null) so connect-args assertions are
  // deterministic regardless of test order.
  useVoicePrefsStore.setState({
    pauseBeforeReplyMs: null,
    interruptSensitivity: null,
    // A first-ever voice entry gets the preferences card rather than a session
    // (see `voice-entry-guards`); the drain tests here are about the starter,
    // so they run as a user who has entered voice before.
    firstRunSeen: true,
  });
  __resetPendingDeepLinkForTesting();
  useConversationStore.getState().reset();
  useAssistantIdentityStore.setState({ assistantId: null, version: null });
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
  interruptionHandlers = [];
  onNativeAndroid = false;
  onNativeIOS = false;
  preflightLiveVoice.mockClear();
  preflightLiveVoice.mockImplementation(async () => ({ status: "ready" }));
  activateVoiceAudioSession.mockClear();
  activateVoiceAudioSession.mockImplementation(async () => true);
  deactivateVoiceAudioSession.mockClear();
  deactivateVoiceAudioSession.mockImplementation(async () => undefined);
  unsubscribeInterruptions.mockClear();
});

afterEach(() => {
  cleanup();
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore.getState().setStarter(null);
  __resetPendingDeepLinkForTesting();
});

// ---------------------------------------------------------------------------
// Starter registration
// ---------------------------------------------------------------------------

describe("starter registration", () => {
  test("registers a starter on mount and deregisters it on unmount", () => {
    const h = renderPersistentController();
    expect(useLiveVoiceStore.getState().starter).not.toBeNull();

    act(() => {
      h.view.unmount();
    });
    expect(useLiveVoiceStore.getState().starter).toBeNull();
  });

  test("starter starts a session with the given conversation", async () => {
    const h = renderPersistentController();
    await startListeningViaStarter(h, "conv-1");

    expect(h.lastClient().connectArgs).toEqual({
      assistantId: "assistant-1",
      conversationId: "conv-1",
      turnDetection: "server_vad",
    });
    expect(useLiveVoiceStore.getState().state).toBe("listening");
    expect(useLiveVoiceStore.getState().conversationId).toBe("conv-1");
    expect(useLiveVoiceStore.getState().controls).not.toBeNull();
  });

  test("starter prewarms playback without opening a session", () => {
    const h = renderPersistentController();

    useLiveVoiceStore.getState().starter?.prewarm();

    expect(h.player.prewarmCount).toBe(1);
    expect(h.clients).toHaveLength(0);
    expect(h.captures).toHaveLength(0);
    expect(useLiveVoiceStore.getState().state).toBe("idle");
  });

  test("starter maps a null conversation to a conversation-less start (draft case)", async () => {
    const h = renderPersistentController();
    await act(async () => {
      useLiveVoiceStore.getState().starter?.start("assistant-1", null);
      await Promise.resolve();
    });

    expect(h.lastClient().connectArgs).toEqual({
      assistantId: "assistant-1",
      conversationId: undefined,
      turnDetection: "server_vad",
    });
    expect(useLiveVoiceStore.getState().startedConversationId).toBeNull();
  });

  test("drains a start-voice deep link parked before this mount (cold launch)", async () => {
    useAssistantIdentityStore.setState({
      assistantId: "assistant-1",
      version: "0.10.12",
    });
    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
    useConversationStore.getState().setActiveConversationId("conv-1");
    usePendingDeepLinkStore.getState().setPendingVoiceStart();

    const h = renderPersistentController();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The drain mints a conversation for the session and lands on it, so the
    // composer there can own it and show the room. Not `conv-1`: a start asked
    // for from outside the chat is a new call, and the selection it finds is
    // just wherever the user was last.
    const draftId =
      useConversationStore.getState().activeConversationId ?? undefined;
    expect(draftId).toBeDefined();
    expect(draftId).not.toBe("conv-1");
    expect(h.lastClient().connectArgs).toEqual({
      assistantId: "assistant-1",
      conversationId: draftId,
      turnDetection: "server_vad",
    });
    expect(usePendingDeepLinkStore.getState().pendingVoiceStartAt).toBeNull();
  });

  test("mounting with nothing parked starts no session", async () => {
    const h = renderPersistentController();
    await act(async () => {
      await Promise.resolve();
    });

    expect(h.clients).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Re-draining a parked start when the active assistant changes
// ---------------------------------------------------------------------------

/**
 * The drain has two triggers, and only the second serves a reparked request.
 *
 * `drainPendingVoiceStart` leaves the request parked when the active assistant
 * changed while its preflight was in flight, because the eligibility gate and
 * the readiness verdict both answered for the assistant the user has just left.
 * The starter-registration effect above cannot run that next drain: it is keyed
 * on the starter's identity, which a switch does not touch. So the switch runs
 * it, and a press the user really made is served on the assistant they moved to
 * rather than sitting until its TTL takes it.
 */
describe("re-draining on an assistant switch", () => {
  /** Resolved, active, and new enough to serve live voice. */
  function activeAssistant(assistantId: string): void {
    useAssistantIdentityStore.setState({ assistantId, version: "0.10.12" });
    useResolvedAssistantsStore.setState({ activeAssistantId: assistantId });
  }

  /**
   * Let the fire-and-forget drains run out. They cannot be awaited by design,
   * and each one awaits the version resolution, the preflight, and the start.
   */
  async function flushDrains(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 12; i++) {
        await Promise.resolve();
      }
    });
  }

  test("a request reparked mid-preflight starts on the assistant switched to", async () => {
    activeAssistant("assistant-1");
    usePendingDeepLinkStore.getState().setPendingVoiceStart();
    let releasePreflight: () => void = () => {};
    preflightLiveVoice.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePreflight = () => {
            resolve({ status: "ready" });
          };
        }),
    );

    // The mount's drain gets as far as the held preflight and no further.
    const h = renderPersistentController();
    await flushDrains();
    expect(h.clients).toHaveLength(0);

    // The user switches assistants with that preflight still open, so the drain
    // reparks when it resumes.
    act(() => {
      activeAssistant("assistant-2");
      releasePreflight();
    });
    await flushDrains();

    const draftId =
      useConversationStore.getState().activeConversationId ?? undefined;
    expect(draftId).toBeDefined();
    expect(h.clients).toHaveLength(1);
    expect(h.lastClient().connectArgs).toEqual({
      assistantId: "assistant-2",
      conversationId: draftId,
      turnDetection: "server_vad",
    });
    // Spent, rather than left parked for the TTL to throw away.
    expect(usePendingDeepLinkStore.getState().pendingVoiceStartAt).toBeNull();
  });

  test("a switch waits for the new assistant's identity before deciding", async () => {
    // The real ordering, which the helper above collapses: the subscription
    // fires on the resolved-assistants change, and the identity store is still
    // holding the previous assistant's version at that moment. The eligibility
    // gate is owner-scoped, so a drain that decides now reads the press as
    // unsupported and throws it away instead of serving it.
    activeAssistant("assistant-1");
    const h = renderPersistentController();
    await flushDrains();

    // Parked directly, so nothing drains it until the switch does.
    usePendingDeepLinkStore.getState().setPendingVoiceStart();
    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" });
    });
    await flushDrains();

    expect(h.clients).toHaveLength(0);
    expect(
      usePendingDeepLinkStore.getState().pendingVoiceStartAt,
    ).not.toBeNull();

    // `useAssistantIdentityInit` clears, then hydrates for the assistant the
    // user moved to. That is what the drain has been waiting on.
    act(() => {
      useAssistantIdentityStore.setState({ assistantId: null, version: null });
      useAssistantIdentityStore.setState({
        assistantId: "assistant-2",
        version: "0.10.12",
      });
    });
    await flushDrains();

    const draftId =
      useConversationStore.getState().activeConversationId ?? undefined;
    expect(draftId).toBeDefined();
    expect(h.clients).toHaveLength(1);
    expect(h.lastClient().connectArgs).toEqual({
      assistantId: "assistant-2",
      conversationId: draftId,
      turnDetection: "server_vad",
    });
    expect(usePendingDeepLinkStore.getState().pendingVoiceStartAt).toBeNull();
  });

  test("a switch with nothing parked starts nothing", async () => {
    activeAssistant("assistant-1");
    const h = renderPersistentController();
    await flushDrains();

    act(() => {
      activeAssistant("assistant-2");
    });
    await flushDrains();

    expect(h.clients).toHaveLength(0);
    expect(useLiveVoiceStore.getState().state).toBe("idle");
  });

  test("a switch after the request was served starts no second session", async () => {
    // The park is one-shot, so the trigger cannot turn every later switch into
    // a session the user never asked for.
    activeAssistant("assistant-1");
    usePendingDeepLinkStore.getState().setPendingVoiceStart();
    const h = renderPersistentController();
    await flushDrains();
    expect(h.clients).toHaveLength(1);

    act(() => {
      activeAssistant("assistant-2");
    });
    await flushDrains();

    expect(h.clients).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Session lifetime — the reason the controller lives in the layout
// ---------------------------------------------------------------------------

describe("session lifetime", () => {
  test("session keeps running while store consumers (composer, pill) mount and unmount around it", async () => {
    const h = renderPersistentController();
    await startListeningViaStarter(h);

    // A store consumer standing in for the composer/pill: subscribes, then
    // unmounts (navigation to another thread / Home / the app viewer). Only
    // the controller's unmount may tear the session down.
    const consumer = renderHook(() => useLiveVoiceStore.use.state());
    expect(consumer.result.current).toBe("listening");
    act(() => {
      consumer.unmount();
    });

    expect(useLiveVoiceStore.getState().state).toBe("listening");
    expect(h.lastClient().closed).toBe(false);
    expect(h.lastCapture().shutdownCount).toBe(0);
  });

  test("controls registered by the session remain driveable after consumers are gone", async () => {
    const h = renderPersistentController();
    await startListeningViaStarter(h);

    await act(async () => {
      useLiveVoiceStore.getState().controls?.stop();
      await Promise.resolve();
    });

    expect(h.lastClient().ended).toBe(true);
    expect(useLiveVoiceStore.getState().state).toBe("idle");
    expect(h.lastCapture().shutdownCount).toBe(1);
  });

  test("starter survives session teardown — a second session can start after the first ends", async () => {
    const h = renderPersistentController();
    await startListeningViaStarter(h, "conv-1");
    await act(async () => {
      useLiveVoiceStore.getState().controls?.stop();
      await Promise.resolve();
    });
    expect(useLiveVoiceStore.getState().state).toBe("idle");
    expect(useLiveVoiceStore.getState().starter).not.toBeNull();

    await startListeningViaStarter(h, "conv-2");
    expect(useLiveVoiceStore.getState().state).toBe("listening");
    expect(useLiveVoiceStore.getState().conversationId).toBe("conv-2");
    expect(h.clients).toHaveLength(2);
  });

  test("unmounting the controller (leaving the chat layout) tears the session down", async () => {
    const h = renderPersistentController();
    await startListeningViaStarter(h);

    act(() => {
      h.view.unmount();
    });

    // No invisible live microphone: mic + socket released, store idle.
    expect(h.lastClient().closed).toBe(true);
    expect(h.lastCapture().shutdownCount).toBe(1);
    expect(useLiveVoiceStore.getState().state).toBe("idle");
    expect(useLiveVoiceStore.getState().starter).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Native audio session — held for exactly the span of a voice session
// ---------------------------------------------------------------------------

describe("native audio session", () => {
  // The regression guard. Activating our own AVAudioSession alongside the one
  // WebKit holds for getUserMedia has broken live voice on a handset twice:
  // #39331 (no capture at all, reverted in #39345) and again in #39306, where
  // a session died ~60ms after its socket opened. Nothing may reintroduce it
  // without a device test, and the Simulator cannot provide one.
  test("iOS never activates an audio session of its own", async () => {
    onNativeIOS = true;
    const h = renderPersistentController();
    await startListeningViaStarter(h);

    // The churn a real turn produces, none of which may reach the bridge.
    for (const phase of [
      "transcribing",
      "thinking",
      "speaking",
      "listening",
    ] as const) {
      await act(async () => {
        useLiveVoiceStore.getState().setState(phase);
        await Promise.resolve();
      });
    }

    expect(activateVoiceAudioSession).not.toHaveBeenCalled();
    expect(deactivateVoiceAudioSession).not.toHaveBeenCalled();
  });

  test("iOS never deactivates one through idle, failure, or unmount", async () => {
    onNativeIOS = true;
    const h = renderPersistentController();
    await startListeningViaStarter(h);

    await act(async () => {
      useLiveVoiceStore.getState().fail("velay unreachable");
      await Promise.resolve();
    });
    await act(async () => {
      useLiveVoiceStore.getState().setState("idle");
      await Promise.resolve();
    });
    act(() => {
      h.view.unmount();
    });

    expect(deactivateVoiceAudioSession).not.toHaveBeenCalled();
  });

  test("Android holds audio focus for exactly the active session", async () => {
    onNativeAndroid = true;
    const h = renderPersistentController();
    await startListeningViaStarter(h);
    expect(activateVoiceAudioSession).toHaveBeenCalledTimes(1);
    await act(async () => {
      useLiveVoiceStore.getState().controls?.stop();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(deactivateVoiceAudioSession).toHaveBeenCalledTimes(1);
  });

  test("Android starts background voice only after microphone capture succeeds", async () => {
    onNativeAndroid = true;
    const h = renderPersistentController((capture) => {
      capture.deferStart = true;
    });

    await act(async () => {
      useLiveVoiceStore.getState().starter?.start("assistant-1", "conv-1");
      await Promise.resolve();
    });
    expect(useLiveVoiceStore.getState().state).toBe("connecting");
    expect(activateVoiceAudioSession).not.toHaveBeenCalled();

    await act(async () => {
      h.lastCapture().resolveStart();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(activateVoiceAudioSession).toHaveBeenCalledTimes(1);
  });

  test("Android keeps background voice active while reconnecting", async () => {
    onNativeAndroid = true;
    const h = renderPersistentController();
    await startListeningViaStarter(h);

    await act(async () => {
      useLiveVoiceStore.getState().setMicrophoneActive(false);
      useLiveVoiceStore.getState().setState("connecting");
      await Promise.resolve();
    });

    expect(activateVoiceAudioSession).toHaveBeenCalledTimes(1);
    expect(deactivateVoiceAudioSession).not.toHaveBeenCalled();
  });

  test("Android preserves a pending background activation across reconnects", async () => {
    onNativeAndroid = true;
    let finishActivation: ((activated: boolean) => void) | undefined;
    activateVoiceAudioSession.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishActivation = resolve;
        }),
    );
    renderPersistentController();

    await act(async () => {
      useLiveVoiceStore.getState().starter?.start("assistant-1", "conv-1");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(activateVoiceAudioSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      useLiveVoiceStore.getState().setMicrophoneActive(false);
      useLiveVoiceStore.getState().setState("connecting");
      await Promise.resolve();
      finishActivation?.(true);
      await Promise.resolve();
    });

    expect(deactivateVoiceAudioSession).not.toHaveBeenCalled();
  });

  test("Android caps denied focus retries per session", async () => {
    onNativeAndroid = true;
    const outcomes = [false, false, false, true];
    activateVoiceAudioSession.mockImplementation(
      async () => outcomes.shift() ?? true,
    );
    renderPersistentController();
    await act(async () => {
      useLiveVoiceStore.getState().starter?.start("assistant-1", "conv-1");
      await Promise.resolve();
    });
    expect(activateVoiceAudioSession).toHaveBeenCalledTimes(1);
    for (const phase of ["listening", "thinking", "speaking"] as const) {
      await act(async () => {
        useLiveVoiceStore.getState().setState(phase);
        await Promise.resolve();
      });
    }
    expect(activateVoiceAudioSession).toHaveBeenCalledTimes(2);
    for (const phase of ["idle", "connecting", "listening"] as const) {
      await act(async () => {
        useLiveVoiceStore.getState().setState(phase);
        await Promise.resolve();
      });
    }
    expect(activateVoiceAudioSession).toHaveBeenCalledTimes(4);
  });

  test("Android route changes do not end the session", async () => {
    onNativeAndroid = true;
    const h = renderPersistentController();
    await startListeningViaStarter(h);
    act(() => {
      emitInterruption({ type: "began", reason: "route-change" });
    });
    expect(useLiveVoiceStore.getState().state).toBe("listening");
    expect(h.lastClient().closed).toBe(false);
  });

  test("Android releases focus after a native interruption ends voice", async () => {
    onNativeAndroid = true;
    const h = renderPersistentController();
    await startListeningViaStarter(h);
    await act(async () => {
      emitInterruption({ type: "began" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.lastClient().ended).toBe(true);
    expect(deactivateVoiceAudioSession).toHaveBeenCalledTimes(1);
  });

  test("drops the interruption listener on unmount", async () => {
    const h = renderPersistentController();
    await startListeningViaStarter(h);

    act(() => {
      h.view.unmount();
    });

    expect(unsubscribeInterruptions).toHaveBeenCalledTimes(1);
  });

  test("an interruption ends the active session", async () => {
    const h = renderPersistentController();
    await startListeningViaStarter(h);

    await act(async () => {
      emitInterruption({ type: "began" });
      await Promise.resolve();
    });

    // A phone call took the mic; the session ends rather than listening into
    // a dead input. The interruption arrives on WebKit's session, which is why
    // this still works without us owning one.
    expect(h.lastClient().ended).toBe(true);
    expect(useLiveVoiceStore.getState().state).toBe("idle");
  });

  test("an interruption ending does not resume or disturb the session", async () => {
    const h = renderPersistentController();
    await startListeningViaStarter(h);

    await act(async () => {
      emitInterruption({ type: "ended" });
      await Promise.resolve();
    });

    expect(useLiveVoiceStore.getState().state).toBe("listening");
    expect(h.lastClient().closed).toBe(false);
  });

  test("an interruption with no session running is a no-op", async () => {
    const h = renderPersistentController();

    await act(async () => {
      emitInterruption({ type: "began" });
      await Promise.resolve();
    });

    expect(h.clients).toHaveLength(0);
    expect(useLiveVoiceStore.getState().state).toBe("idle");
  });

  // The skew case: an App Store shell older than the `VoiceAudioSession`
  // plugin, where even the interruption listener never fires. Voice must behave
  // exactly as it does with one. `runtime/native-audio-session.test.ts` pins the
  // bridge's own off-native and missing-plugin behavior directly.
  test("a bridge with no plugin behind it neither blocks nor breaks a session", async () => {
    const h = renderPersistentController();
    await startListeningViaStarter(h);
    expect(useLiveVoiceStore.getState().state).toBe("listening");

    await act(async () => {
      useLiveVoiceStore.getState().controls?.stop();
      await Promise.resolve();
    });

    expect(h.lastClient().ended).toBe(true);
    expect(useLiveVoiceStore.getState().state).toBe("idle");
  });

  test("amplitude and transcript churn never re-renders the controller's host", async () => {
    const h = renderPersistentController();
    await startListeningViaStarter(h);
    const renders = h.renderCount();

    // The `observeAudioState: false` contract. The audio-session lifecycle
    // reads `state` through `useLiveVoiceStore.subscribe` inside an effect,
    // never a reactive selector, so the per-frame amplitude and transcript
    // deltas a live session emits stay free for the mounting layout.
    act(() => {
      const store = useLiveVoiceStore.getState();
      store.setInputAmplitude(0.4);
      store.setPartialTranscript("hello");
      store.appendAssistantTranscript("hi");
    });

    expect(h.renderCount()).toBe(renders);
  });
});
