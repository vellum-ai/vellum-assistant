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
type InterruptionEvent = { type: "began" | "ended"; shouldResume: boolean };
const activateVoiceAudioSession = mock(async () => true);
const deactivateVoiceAudioSession = mock(async () => undefined);
const unsubscribeInterruptions = mock(() => undefined);
let interruptionHandlers: ((event: InterruptionEvent) => void)[] = [];

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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function renderPersistentController() {
  // One client/capture pair per started session, like the real factories.
  const clients: FakeClient[] = [];
  const captures: FakeCapture[] = [];
  const player = new FakePlayer();

  let renderCount = 0;

  const view = renderHook(() => {
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
        captures.push(capture);
        return capture as unknown as LiveVoiceAudioCapture;
      },
    });
  });

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
    useLiveVoiceStore.getState().starter?.("assistant-1", conversationId);
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
  });
  __resetPendingDeepLinkForTesting();
  useAssistantIdentityStore.setState({ assistantId: null, version: null });
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
  interruptionHandlers = [];
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

  test("starter maps a null conversation to a conversation-less start (draft case)", async () => {
    const h = renderPersistentController();
    await act(async () => {
      useLiveVoiceStore.getState().starter?.("assistant-1", null);
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
    usePendingDeepLinkStore.getState().setPendingVoiceStart();

    const h = renderPersistentController();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.lastClient().connectArgs).toEqual({
      assistantId: "assistant-1",
      conversationId: undefined,
      turnDetection: "server_vad",
    });
    expect(usePendingDeepLinkStore.getState().pendingVoiceStart).toBe(false);
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
  test("activates once per session, not once per phase change", async () => {
    const h = renderPersistentController();
    expect(activateVoiceAudioSession).not.toHaveBeenCalled();

    await startListeningViaStarter(h);
    expect(activateVoiceAudioSession).toHaveBeenCalledTimes(1);

    // The churn a real turn produces. The audio session is already held; none
    // of this may re-activate it.
    act(() => {
      useLiveVoiceStore.getState().setState("thinking");
      useLiveVoiceStore.getState().setState("speaking");
      useLiveVoiceStore.getState().setState("listening");
    });
    expect(activateVoiceAudioSession).toHaveBeenCalledTimes(1);
    expect(deactivateVoiceAudioSession).not.toHaveBeenCalled();
  });

  test("deactivates when the session reaches idle", async () => {
    const h = renderPersistentController();
    await startListeningViaStarter(h);

    await act(async () => {
      useLiveVoiceStore.getState().controls?.stop();
      await Promise.resolve();
    });

    expect(useLiveVoiceStore.getState().state).toBe("idle");
    expect(deactivateVoiceAudioSession).toHaveBeenCalledTimes(1);
  });

  test("deactivates when the session fails", async () => {
    const h = renderPersistentController();
    await startListeningViaStarter(h);

    act(() => {
      useLiveVoiceStore.getState().fail("velay unreachable");
    });

    expect(deactivateVoiceAudioSession).toHaveBeenCalledTimes(1);
  });

  test("deactivates on unmount and drops the interruption listener", async () => {
    const h = renderPersistentController();
    await startListeningViaStarter(h);

    act(() => {
      h.view.unmount();
    });

    // Exactly one release, whichever order the controller's own teardown and
    // this cleanup happen to run in.
    expect(deactivateVoiceAudioSession).toHaveBeenCalledTimes(1);
    expect(unsubscribeInterruptions).toHaveBeenCalledTimes(1);
  });

  test("unmounting without a session deactivates nothing", () => {
    const h = renderPersistentController();

    act(() => {
      h.view.unmount();
    });

    expect(activateVoiceAudioSession).not.toHaveBeenCalled();
    expect(deactivateVoiceAudioSession).not.toHaveBeenCalled();
  });

  test("an interruption ends the active session", async () => {
    const h = renderPersistentController();
    await startListeningViaStarter(h);

    await act(async () => {
      emitInterruption({ type: "began", shouldResume: true });
      await Promise.resolve();
    });

    // A phone call took the mic; the session ends rather than listening into
    // a dead input.
    expect(h.lastClient().ended).toBe(true);
    expect(useLiveVoiceStore.getState().state).toBe("idle");
    expect(deactivateVoiceAudioSession).toHaveBeenCalledTimes(1);
  });

  test("an interruption ending does not resume or disturb the session", async () => {
    const h = renderPersistentController();
    await startListeningViaStarter(h);

    await act(async () => {
      emitInterruption({ type: "ended", shouldResume: true });
      await Promise.resolve();
    });

    expect(useLiveVoiceStore.getState().state).toBe("listening");
    expect(h.lastClient().closed).toBe(false);
    expect(activateVoiceAudioSession).toHaveBeenCalledTimes(1);
  });

  test("an interruption with no session running is a no-op", async () => {
    const h = renderPersistentController();

    await act(async () => {
      emitInterruption({ type: "began", shouldResume: false });
      await Promise.resolve();
    });

    expect(h.clients).toHaveLength(0);
    expect(useLiveVoiceStore.getState().state).toBe("idle");
  });

  // The skew case: an App Store shell older than the `VoiceAudioSession`
  // plugin. Voice must behave exactly as it does today.
  test("a failing bridge neither blocks nor breaks a session", async () => {
    activateVoiceAudioSession.mockImplementation(async () => {
      throw new Error("VoiceAudioSession does not have web implementation.");
    });
    deactivateVoiceAudioSession.mockImplementation(async () => {
      throw new Error("VoiceAudioSession does not have web implementation.");
    });

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
