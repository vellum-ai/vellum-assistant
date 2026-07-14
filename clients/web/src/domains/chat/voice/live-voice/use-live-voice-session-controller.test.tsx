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

  const view = renderHook(() =>
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
    }),
  );

  return {
    view,
    player,
    clients,
    captures,
    lastClient: () => clients[clients.length - 1]!,
    lastCapture: () => captures[captures.length - 1]!,
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
});

afterEach(() => {
  cleanup();
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore.getState().setStarter(null);
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
