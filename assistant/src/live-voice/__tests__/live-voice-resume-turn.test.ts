import { describe, expect, mock, test } from "bun:test";

import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import { getVoiceResumeHandler } from "../live-voice-resume-registry.js";
import { LiveVoiceSession } from "../live-voice-session.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
import type {
  LiveVoiceTtsAudioChunk,
  LiveVoiceTtsOptions,
  LiveVoiceTtsResult,
} from "../live-voice-tts.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
} from "../protocol.js";

const CONVERSATION_ID = "conversation-resume-1";

const START_FRAME = {
  type: "start",
  conversationId: CONVERSATION_ID,
  audio: {
    mimeType: "audio/pcm",
    sampleRate: 24_000,
    channels: 1,
  },
} as const satisfies LiveVoiceClientStartFrame;

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  stopped = false;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(): void {}

  stop(): void {
    this.stopped = true;
  }
}

function createContext(): {
  context: LiveVoiceSessionFactoryContext;
  frames: LiveVoiceServerFrame[];
} {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  return {
    frames,
    context: {
      sessionId: "session-resume-1",
      startFrame: START_FRAME,
      sendFrame: mock(async (payload) => {
        const frame = sequencer.next(payload);
        frames.push(frame);
        return frame;
      }),
    },
  };
}

function makeTtsChunk(text: string): LiveVoiceTtsAudioChunk {
  return {
    type: "tts_audio",
    contentType: "audio/pcm",
    sampleRate: 24_000,
    dataBase64: Buffer.from(text).toString("base64"),
  };
}

function makeTtsResult(text: string): LiveVoiceTtsResult {
  return {
    provider: "fish-audio",
    contentType: "audio/pcm",
    sampleRate: 24_000,
    chunks: 1,
    bytes: Buffer.byteLength(text),
  };
}

// A startVoiceTurn that immediately streams a reply delta and completes, with
// no reliance on any audio input. Returned as the raw mock so tests can assert
// on `.mock.calls`.
function spokenReplyStarter() {
  return mock(async (options: VoiceTurnOptions) => {
    const callbacks: VoiceTurnCallbacks | undefined = options.callbacks;
    callbacks?.assistant_text_delta?.({
      type: "assistant_text_delta",
      text: "All set, you are connected.",
      conversationId: options.conversationId,
    });
    callbacks?.message_complete?.({
      type: "message_complete",
      conversationId: options.conversationId,
      messageId: "assistant-message-resume",
    });
    return { turnId: "bridge-turn-resume", abort: mock() };
  });
}

function createSessionHarness() {
  const transcriber = new MockStreamingTranscriber();
  const { context, frames } = createContext();
  const streamTtsAudio = mock(async (opts: LiveVoiceTtsOptions) => {
    opts.onAudioChunk(makeTtsChunk(`audio:${opts.text}`));
    return makeTtsResult(opts.text);
  });
  const startVoiceTurn = spokenReplyStarter();
  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(async () => transcriber),
    startVoiceTurn,
    streamTtsAudio,
    createTurnId: () => "live-turn-resume",
  });
  return { frames, session, startVoiceTurn };
}

async function waitFor(
  predicate: () => boolean,
  message = "Timed out waiting for live voice resume condition",
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

describe("LiveVoiceSession surface resume", () => {
  test("registers a discoverable resume handler for its conversation", async () => {
    const { session } = createSessionHarness();
    await session.start();
    expect(getVoiceResumeHandler(CONVERSATION_ID)).toBeDefined();
    await session.close("client_end");
  });

  test("resumeWithText drives a spoken turn (text delta + tts_audio + tts_done)", async () => {
    const { frames, session, startVoiceTurn } = createSessionHarness();
    await session.start();

    const handler = getVoiceResumeHandler(CONVERSATION_ID);
    expect(handler).toBeDefined();

    // No audio input at all — the resume alone must produce a spoken turn.
    handler?.resumeWithText("Thanks for connecting Google.");

    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(startVoiceTurn).toHaveBeenCalledTimes(1);
    expect(startVoiceTurn.mock.calls[0]?.[0]).toMatchObject({
      conversationId: CONVERSATION_ID,
      content: "Thanks for connecting Google.",
    });
    const frameTypes = frames.map((frame) => frame.type);
    expect(frameTypes).toContain("assistant_text_delta");
    expect(frameTypes).toContain("tts_audio");
    expect(frameTypes).toContain("tts_done");
    // A spoken resume is not echoed as user speech.
    expect(frameTypes).not.toContain("user_message_echo");

    await session.close("client_end");
  });

  test("unregisters the resume handler on close", async () => {
    const { session } = createSessionHarness();
    await session.start();
    expect(getVoiceResumeHandler(CONVERSATION_ID)).toBeDefined();
    await session.close("client_end");
    expect(getVoiceResumeHandler(CONVERSATION_ID)).toBeUndefined();
  });

  test("ignores an empty resume and does not start a turn", async () => {
    const { frames, session, startVoiceTurn } = createSessionHarness();
    await session.start();
    getVoiceResumeHandler(CONVERSATION_ID)?.resumeWithText("   ");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(startVoiceTurn).not.toHaveBeenCalled();
    expect(frames.some((frame) => frame.type === "thinking")).toBe(false);
    await session.close("client_end");
  });
});
