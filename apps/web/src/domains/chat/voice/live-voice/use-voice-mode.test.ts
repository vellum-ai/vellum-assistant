/**
 * Tests for the `useVoiceMode` conversation loop.
 *
 * The live-voice primitives are replaced with the shared fakes; each session
 * the loop opens creates a fresh client/capture/player triple, so the arrays
 * record the loop's reconnects. The Electron bridge is stubbed on `window`
 * to capture published voice states.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

// Keep the generated SDK out of the import graph (see use-live-voice.test.ts).
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
} from "@/domains/chat/voice/live-voice/test-fakes";
import { LS_CONVERSATION_TIMEOUT } from "@/utils/voice-conversation-timeout";

const { useVoiceMode } = await import(
  "@/domains/chat/voice/live-voice/use-voice-mode"
);
const { useVoiceModeStore } = await import(
  "@/domains/chat/voice/live-voice/voice-mode-store"
);
const { useLiveVoiceStore } = await import(
  "@/domains/chat/voice/live-voice/live-voice-store"
);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const publishedStates: string[] = [];

function renderVoiceMode(options: { conversationId?: string } = {}) {
  const clients: FakeClient[] = [];
  const captures: FakeCapture[] = [];
  const players: FakePlayer[] = [];

  const view = renderHook(() =>
    useVoiceMode({
      assistantId: "assistant-1",
      conversationId: options.conversationId,
      liveVoice: {
        createClient: () => {
          const client = new FakeClient();
          clients.push(client);
          return client as unknown as LiveVoiceChannelClient;
        },
        createCapture: (captureOptions) => {
          const capture = new FakeCapture(captureOptions);
          captures.push(capture);
          return capture as unknown as LiveVoiceAudioCapture;
        },
        createPlayer: () => {
          const player = new FakePlayer();
          players.push(player);
          return player as unknown as LiveVoiceAudioPlayer;
        },
      },
    }),
  );

  return {
    view,
    clients,
    captures,
    players,
    client: () => clients[clients.length - 1]!,
    capture: () => captures[captures.length - 1]!,
    player: () => players[players.length - 1]!,
  };
}

type Harness = ReturnType<typeof renderVoiceMode>;

/** Activate the mode and drive the newest session to `listening`. */
async function activateToListening(h: Harness, conversationId = "conv-1") {
  await act(async () => {
    await h.view.result.current.activate();
  });
  await emitReady(h, conversationId);
}

/** Emit `ready` on the newest session and settle capture start. */
async function emitReady(h: Harness, conversationId = "conv-1") {
  await act(async () => {
    h.client().emit("ready", {
      type: "ready",
      seq: 1,
      sessionId: `s${h.clients.length}`,
      conversationId,
    });
    await Promise.resolve();
  });
}

/** Drive the newest session into `speaking` (thinking + first TTS frame). */
function startSpeaking(h: Harness) {
  act(() => {
    h.client().emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
    h.client().emit("ttsAudio", {
      type: "tts_audio",
      seq: 3,
      mimeType: "audio/pcm",
      sampleRate: 24000,
      dataBase64: "AAAA",
    });
  });
}

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
  useVoiceModeStore.getState().reset();
  publishedStates.length = 0;
  localStorage.removeItem(LS_CONVERSATION_TIMEOUT);
  (window as { vellum?: unknown }).vellum = {
    platform: "electron",
    voice: {
      setState: (state: string) => {
        publishedStates.push(state);
      },
    },
  };
});

afterEach(() => {
  cleanup();
  useLiveVoiceStore.getState().reset();
  useVoiceModeStore.getState().reset();
  localStorage.removeItem(LS_CONVERSATION_TIMEOUT);
  delete (window as { vellum?: unknown }).vellum;
});

// ---------------------------------------------------------------------------
// Activation & state projection
// ---------------------------------------------------------------------------

describe("activation", () => {
  test("activate opens a session and the mode reaches listening", async () => {
    const h = renderVoiceMode({ conversationId: "conv-init" });

    expect(h.view.result.current.state).toBe("off");

    await activateToListening(h, "conv-init");

    expect(h.clients).toHaveLength(1);
    expect(h.client().connectArgs).toEqual({
      assistantId: "assistant-1",
      conversationId: "conv-init",
    });
    expect(h.view.result.current.state).toBe("listening");
    expect(publishedStates).toContain("listening");
  });

  test("session phases project to coarse mode states", async () => {
    const h = renderVoiceMode();
    await activateToListening(h);

    act(() => {
      h.client().emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
    });
    expect(h.view.result.current.state).toBe("processing");

    startSpeaking(h);
    expect(h.view.result.current.state).toBe("speaking");
    expect(publishedStates).toContain("processing");
    expect(publishedStates).toContain("speaking");
  });
});

// ---------------------------------------------------------------------------
// The conversation loop
// ---------------------------------------------------------------------------

describe("conversation loop", () => {
  test("a completed response auto-starts the next turn on the same conversation", async () => {
    const h = renderVoiceMode();
    await activateToListening(h, "conv-from-server");
    startSpeaking(h);

    await act(async () => {
      h.client().emit("ttsDone", { type: "tts_done", seq: 4, turnId: "t1" });
      h.player().finishPlayback();
      await Promise.resolve();
      await Promise.resolve();
    });

    // A fresh session was opened automatically, attached to the conversation
    // the server issued for the first one.
    expect(h.clients).toHaveLength(2);
    expect(h.client().connectArgs).toEqual({
      assistantId: "assistant-1",
      conversationId: "conv-from-server",
    });

    await emitReady(h, "conv-from-server");
    expect(h.view.result.current.state).toBe("listening");
  });

  test("a silent (no-TTS) response still advances the loop to the next turn", async () => {
    // tts_done with no tts_audio: the session never reaches `speaking`, but
    // the loop must re-listen anyway (mirrors the macOS idle auto-restart)
    // rather than hanging in `processing` until the user stops it.
    const h = renderVoiceMode();
    await activateToListening(h);

    await act(async () => {
      h.client().emit("thinking", { type: "thinking", seq: 2, turnId: "t1" });
      h.client().emit("ttsDone", { type: "tts_done", seq: 3, turnId: "t1" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.clients).toHaveLength(2);
    await emitReady(h);
    expect(h.view.result.current.state).toBe("listening");
  });

  test("voice barge-in while speaking interrupts and resumes listening", async () => {
    const h = renderVoiceMode();
    await activateToListening(h);
    startSpeaking(h);

    const speakingClient = h.clients[0]!;
    await act(async () => {
      h.captures[0]!.pushAmplitude(0.2); // over the barge-in threshold
      await Promise.resolve();
    });

    // The interrupted session sent `interrupt` and a replacement session
    // opened immediately — speaking → listening without user action.
    expect(speakingClient.interruptCount).toBe(1);
    expect(h.players[0]!.isPlaying).toBe(false);
    expect(h.clients).toHaveLength(2);

    await emitReady(h);
    expect(h.view.result.current.state).toBe("listening");
  });

  test("interrupt() (mic button mid-playback) behaves like voice barge-in", async () => {
    const h = renderVoiceMode();
    await activateToListening(h);
    startSpeaking(h);

    await act(async () => {
      h.view.result.current.interrupt();
      await Promise.resolve();
    });

    expect(h.clients[0]!.interruptCount).toBe(1);
    expect(h.clients).toHaveLength(2);

    await emitReady(h);
    expect(h.view.result.current.state).toBe("listening");
  });

  test("interrupt() outside speaking is a no-op", async () => {
    const h = renderVoiceMode();
    await activateToListening(h);

    act(() => {
      h.view.result.current.interrupt();
    });

    expect(h.clients).toHaveLength(1);
    expect(h.client().interruptCount).toBe(0);
    expect(h.view.result.current.state).toBe("listening");
  });
});

// ---------------------------------------------------------------------------
// Deactivation
// ---------------------------------------------------------------------------

describe("deactivation", () => {
  test("deactivate turns the mode off and ends the session", async () => {
    const h = renderVoiceMode();
    await activateToListening(h);

    await act(async () => {
      await h.view.result.current.deactivate();
    });

    expect(h.view.result.current.state).toBe("off");
    expect(h.view.result.current.autoDeactivated).toBe(false);
    expect(h.client().ended).toBe(true);
    // No replacement session: the loop is off.
    expect(h.clients).toHaveLength(1);
    expect(publishedStates[publishedStates.length - 1]).toBe("off");
  });

  test("listening with no speech for the conversation timeout auto-deactivates", async () => {
    localStorage.setItem(LS_CONVERSATION_TIMEOUT, "0.05"); // 50ms
    const h = renderVoiceMode();
    await activateToListening(h);
    expect(h.view.result.current.state).toBe("listening");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    expect(h.view.result.current.state).toBe("off");
    expect(h.view.result.current.autoDeactivated).toBe(true);
    expect(h.clients).toHaveLength(1);
  });

  test("recognized speech keeps the conversation timeout from firing", async () => {
    localStorage.setItem(LS_CONVERSATION_TIMEOUT, "0.08"); // 80ms
    const h = renderVoiceMode();
    await activateToListening(h);

    // Speech arrives before the window elapses; the partial transcript
    // disarms the timer while it is non-empty.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      h.client().emit("sttPartial", { type: "stt_partial", seq: 2, text: "he" });
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    expect(h.view.result.current.state).toBe("listening");
  });

  test("unmount mid-conversation resets the mode and publishes off", async () => {
    const h = renderVoiceMode();
    await activateToListening(h);

    h.view.unmount();

    expect(useVoiceModeStore.getState().state).toBe("off");
    expect(publishedStates[publishedStates.length - 1]).toBe("off");
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe("failure handling", () => {
  test("failed sessions are retried, then the mode turns off with the error", async () => {
    const h = renderVoiceMode();
    await activateToListening(h);

    const failCurrentSession = async () => {
      await act(async () => {
        h.client().emit("error", {
          reason: "protocol-error",
          code: "stt_unavailable",
          message: "no STT provider",
        });
        await Promise.resolve();
      });
    };

    const awaitRetry = async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 450));
      });
    };

    await failCurrentSession();
    expect(h.view.result.current.state).not.toBe("off");
    await awaitRetry();
    expect(h.clients).toHaveLength(2);

    await emitReady(h);
    await failCurrentSession();
    await awaitRetry();
    expect(h.clients).toHaveLength(3);

    await emitReady(h);
    await failCurrentSession();

    // Third consecutive failure exhausts the retries.
    expect(h.view.result.current.state).toBe("off");
    expect(h.view.result.current.error).toBe("no STT provider");
    expect(h.clients).toHaveLength(3);
  });
});
