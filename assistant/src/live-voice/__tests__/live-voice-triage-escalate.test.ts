import { afterEach, describe, expect, mock, test } from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import type { VoiceTurnOptions } from "../../calls/voice-session-bridge.js";
import {
  ESCALATION_CONTINUATION_CONTENT,
  ESCALATION_PROFILE,
  FRONT_DOOR_PROFILE,
  VOICE_TRIAGE_ESCALATE_FLAG,
} from "../../calls/voice-triage-escalate.js";
import { clearFeatureFlagOverridesCache } from "../../config/assistant-feature-flags.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import {
  LiveVoiceSession,
  type LiveVoiceTurnStarter,
} from "../live-voice-session.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
} from "../protocol.js";

const VOICE_MODE_FLAG = "voice-mode";

const START_FRAME = {
  type: "start",
  conversationId: "conversation-123",
  audio: { mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 },
} as const satisfies LiveVoiceClientStartFrame;

class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  stopped = false;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;

  constructor(
    private readonly stopEvents: SttStreamServerEvent[] = [
      { type: "final", text: "world" },
      { type: "closed" },
    ],
  ) {}

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(): void {}

  stop(): void {
    this.stopped = true;
    for (const event of this.stopEvents) {
      this.onEvent?.(event);
    }
  }

  emit(event: SttStreamServerEvent): void {
    this.onEvent?.(event);
  }
}

function createHarness(startVoiceTurn: LiveVoiceTurnStarter) {
  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const context: LiveVoiceSessionFactoryContext = {
    sessionId: "session-123",
    startFrame: START_FRAME,
    sendFrame: mock(async (payload) => {
      const frame = sequencer.next(payload);
      frames.push(frame);
      return frame;
    }),
  };
  const transcriber = new MockStreamingTranscriber();
  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(async () => transcriber),
    startVoiceTurn,
    createTurnId: () => "live-turn-1",
    emitMetrics: false,
  });
  return { frames, session, transcriber };
}

/**
 * A startVoiceTurn mock that scripts the front-door leg's stream and, when it
 * emits [ESCALATE], the escalated leg's stream. Deltas fire on a macrotask so
 * the leg's handle is stored before the marker triggers the hand-off — matching
 * how the real bridge streams deltas after returning the turn handle.
 */
function scriptedStartVoiceTurn(script: {
  frontDoor: string[];
  escalated?: string[];
  // Leave the escalated leg in flight (no deltas, no completion) so a barge-in
  // has a live turn to abort mid-hand-off.
  holdEscalated?: boolean;
}) {
  const frontDoorAbort = mock();
  const escalatedAbort = mock();
  const starter = mock(async (options: VoiceTurnOptions) => {
    const isEscalated = options.content === ESCALATION_CONTINUATION_CONTENT;
    if (isEscalated && script.holdEscalated) {
      return { turnId: "bridge-escalated", abort: escalatedAbort };
    }
    const deltas = isEscalated
      ? (script.escalated ?? ["Here is the careful answer."])
      : script.frontDoor;
    setTimeout(() => {
      for (const text of deltas) {
        options.callbacks?.assistant_text_delta?.({
          type: "assistant_text_delta",
          text,
          conversationId: options.conversationId,
        });
      }
      options.callbacks?.message_complete?.({
        type: "message_complete",
        conversationId: options.conversationId,
        messageId: isEscalated ? "assistant-escalated" : "assistant-front-door",
      });
    }, 0);
    return {
      turnId: isEscalated ? "bridge-escalated" : "bridge-front-door",
      abort: isEscalated ? escalatedAbort : frontDoorAbort,
    };
  });
  return { starter, frontDoorAbort, escalatedAbort };
}

async function driveTurn(session: LiveVoiceSession): Promise<void> {
  await session.start();
  await session.handleClientFrame({ type: "ptt_release" });
}

async function waitFor(
  predicate: () => boolean,
  message = "timed out waiting for live-voice condition",
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function spokenText(frames: LiveVoiceServerFrame[]): string {
  return frames
    .filter((frame) => frame.type === "assistant_text_delta")
    .map((frame) => (frame as { text: string }).text)
    .join("");
}

function enableBothFlags(): void {
  setOverridesForTesting({
    [VOICE_MODE_FLAG]: true,
    [VOICE_TRIAGE_ESCALATE_FLAG]: true,
  });
}

afterEach(() => {
  clearFeatureFlagOverridesCache();
});

describe("live-voice triage-and-escalate routing", () => {
  test("flag off: a single leg runs on the call-site default (no routing options)", async () => {
    const { starter } = scriptedStartVoiceTurn({
      frontDoor: ["A simple reply."],
    });
    const { frames, session } = createHarness(starter);

    await driveTurn(session);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(starter).toHaveBeenCalledTimes(1);
    const options = starter.mock.calls[0]?.[0];
    expect(options?.overrideProfile).toBeUndefined();
    expect(options?.routingLeg).toBeUndefined();
    expect(spokenText(frames)).toBe("A simple reply.");
  });

  test("both flags on, simple turn: only the fast front-door leg runs", async () => {
    enableBothFlags();
    const { starter } = scriptedStartVoiceTurn({
      frontDoor: ["Sure, it's Tuesday."],
    });
    const { frames, session } = createHarness(starter);

    await driveTurn(session);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(starter).toHaveBeenCalledTimes(1);
    expect(starter.mock.calls[0]?.[0]?.overrideProfile).toBe(
      FRONT_DOOR_PROFILE,
    );
    expect(starter.mock.calls[0]?.[0]?.routingLeg).toBe("front-door");
    expect(spokenText(frames)).toBe("Sure, it's Tuesday.");
  });

  test("both flags on, tricky turn: [ESCALATE] hands off to a second quality leg", async () => {
    enableBothFlags();
    const { starter } = scriptedStartVoiceTurn({
      frontDoor: ["Let me think about that. ", "[ESCALATE]"],
      escalated: ["The detailed answer is 42."],
    });
    const { frames, session } = createHarness(starter);

    await driveTurn(session);
    await waitFor(() => starter.mock.calls.length >= 2);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(starter).toHaveBeenCalledTimes(2);
    const frontDoor = starter.mock.calls[0]?.[0];
    const escalated = starter.mock.calls[1]?.[0];
    expect(frontDoor?.overrideProfile).toBe(FRONT_DOOR_PROFILE);
    expect(frontDoor?.routingLeg).toBe("front-door");
    expect(escalated?.overrideProfile).toBe(ESCALATION_PROFILE);
    expect(escalated?.routingLeg).toBe("escalated");
    expect(escalated?.content).toBe(ESCALATION_CONTINUATION_CONTENT);
  });

  test("the [ESCALATE] marker and any text after it never reach the transcript", async () => {
    enableBothFlags();
    const { starter } = scriptedStartVoiceTurn({
      frontDoor: [
        "Let me think about that. ",
        "[ESCALATE] this weak answer kept streaming",
      ],
      escalated: ["The careful answer."],
    });
    const { frames, session } = createHarness(starter);

    await driveTurn(session);
    await waitFor(() => starter.mock.calls.length >= 2);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    const spoken = spokenText(frames);
    expect(spoken).toContain("Let me think about that.");
    expect(spoken).not.toContain("[ESCALATE]");
    expect(spoken).not.toContain("weak answer");
    expect(spoken).toContain("The careful answer.");
  });

  test("a [ESCALATE] marker split across deltas is still detected and suppressed", async () => {
    enableBothFlags();
    const { starter } = scriptedStartVoiceTurn({
      frontDoor: ["One moment. ", "[ESC", "ALATE]", " leftover"],
      escalated: ["Answer."],
    });
    const { frames, session } = createHarness(starter);

    await driveTurn(session);
    await waitFor(() => starter.mock.calls.length >= 2);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    const spoken = spokenText(frames);
    expect(spoken).toContain("One moment.");
    expect(spoken).not.toContain("[ESC");
    expect(spoken).not.toContain("ALATE");
    expect(spoken).not.toContain("leftover");
  });

  test("bare [ESCALATE] with no holding phrase still escalates (fallback bridge)", async () => {
    enableBothFlags();
    const { starter } = scriptedStartVoiceTurn({
      frontDoor: ["[ESCALATE]"],
      escalated: ["The thorough answer."],
    });
    const { frames, session } = createHarness(starter);

    await driveTurn(session);
    await waitFor(() => starter.mock.calls.length >= 2);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(starter).toHaveBeenCalledTimes(2);
    expect(starter.mock.calls[1]?.[0]?.content).toBe(
      ESCALATION_CONTINUATION_CONTENT,
    );
    // The marker itself is never shown; the fallback bridge is audio-only.
    expect(spokenText(frames)).not.toContain("[ESCALATE]");
  });

  test("gating requires BOTH flags: voice-triage-escalate alone does not escalate", async () => {
    setOverridesForTesting({ [VOICE_TRIAGE_ESCALATE_FLAG]: true });
    const { starter } = scriptedStartVoiceTurn({
      frontDoor: ["Let me think. ", "[ESCALATE]"],
    });
    const { frames, session } = createHarness(starter);

    await driveTurn(session);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    // No front-door profile, no escalation — the single leg is the default path.
    expect(starter).toHaveBeenCalledTimes(1);
    expect(starter.mock.calls[0]?.[0]?.overrideProfile).toBeUndefined();
    expect(starter.mock.calls[0]?.[0]?.routingLeg).toBeUndefined();
  });

  test("gating requires BOTH flags: voice-mode alone does not escalate", async () => {
    setOverridesForTesting({ [VOICE_MODE_FLAG]: true });
    const { starter } = scriptedStartVoiceTurn({
      frontDoor: ["Let me think. ", "[ESCALATE]"],
    });
    const { frames, session } = createHarness(starter);

    await driveTurn(session);
    await waitFor(() => frames.some((frame) => frame.type === "tts_done"));

    expect(starter).toHaveBeenCalledTimes(1);
    expect(starter.mock.calls[0]?.[0]?.overrideProfile).toBeUndefined();
    expect(starter.mock.calls[0]?.[0]?.routingLeg).toBeUndefined();
  });

  test("barge-in during the escalated leg aborts it", async () => {
    enableBothFlags();
    const { starter, escalatedAbort } = scriptedStartVoiceTurn({
      frontDoor: ["Let me think about that. ", "[ESCALATE]"],
      holdEscalated: true,
    });
    const { session } = createHarness(starter);

    await driveTurn(session);
    await waitFor(() => starter.mock.calls.length >= 2);
    // Let the escalated leg's handle settle onto the active turn before barging.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const escalatedSignal = starter.mock.calls[1]?.[0]?.signal;

    await session.handleClientFrame({ type: "interrupt" });

    expect(escalatedSignal?.aborted).toBe(true);
    expect(escalatedAbort).toHaveBeenCalledTimes(1);
  });
});
