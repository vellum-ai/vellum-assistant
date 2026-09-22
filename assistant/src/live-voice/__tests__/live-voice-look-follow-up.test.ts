/**
 * Answering a look (`[LOOK:SCREEN]`, `[LOOK:CAMERA]`) on a turn of its own.
 *
 * The reply that asks for a look only acknowledges it. A client that declared
 * `lookFrames` sends a fresh frame once it has carried the look out, and the
 * session answers from that frame without waiting for the user to speak again.
 * Without the declaration, or without the frame, nothing extra runs.
 */

import { describe, expect, mock, test } from "bun:test";

import {
  createMockProvider,
  textResponse,
} from "../../__tests__/helpers/mock-provider.js";
import { setConfig } from "../../__tests__/helpers/set-config.js";
import { waitFor } from "../../__tests__/helpers/wait-for.js";

setConfig("memory", { enabled: false });

import type {
  VoiceTurnCallbacks,
  VoiceTurnOptions,
} from "../../calls/voice-session-bridge.js";
import { ESCALATION_CONTINUATION_CONTENT } from "../../calls/voice-triage-escalate.js";
import { Conversation } from "../../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../../daemon/conversation-registry.js";
import { uploadAttachment } from "../../persistence/attachments-store.js";
import {
  createConversation,
  getMessages,
} from "../../persistence/conversation-crud.js";
import { initializeDb } from "../../persistence/db-init.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../stt/types.js";
import {
  LiveVoiceSession,
  type LiveVoiceTtsStreamer,
} from "../live-voice-session.js";
import type { LiveVoiceSessionFactoryContext } from "../live-voice-session-manager.js";
import type { LiveVoiceTtsOptions } from "../live-voice-tts.js";
import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceServerFrame,
} from "../protocol.js";
import {
  LOOK_FOLLOW_UP_CONTENT,
  LOOK_FRAME_REASON,
} from "../session-controls.js";

await initializeDb();

const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

/** Hands over one spoken sentence each time a capture is released. */
class MockStreamingTranscriber implements StreamingTranscriber {
  readonly providerId = "deepgram" as const;
  readonly boundaryId = "daemon-streaming" as const;
  private onEvent: ((event: SttStreamServerEvent) => void) | null = null;
  stopped = false;

  constructor(private transcript: string) {}

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(): void {}

  emitPartial(text: string): void {
    this.transcript = text;
    this.onEvent?.({ type: "partial", text });
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.transcript.length > 0) {
      this.onEvent?.({ type: "final", text: this.transcript });
    }
    this.onEvent?.({ type: "closed" });
  }
}

function createHarness(options: {
  lookFrames: boolean;
  request?: string;
  handsFree?: boolean;
}) {
  const conversation = createConversation("Look follow-up");
  const { provider } = createMockProvider([textResponse("")]);
  const activeConversation = new Conversation(
    conversation.id,
    provider,
    "system prompt",
    () => {},
    "/tmp",
    { maxTokens: 4096 },
  );
  activeConversation.setTrustContext({
    trustClass: "guardian",
    sourceChannel: "vellum",
  });
  setConversation(conversation.id, activeConversation);

  const sequencer = createLiveVoiceServerFrameSequencer();
  const frames: LiveVoiceServerFrame[] = [];
  const context: LiveVoiceSessionFactoryContext = {
    sessionId: "session-look",
    startFrame: {
      type: "start",
      conversationId: conversation.id,
      audio: { mimeType: "audio/pcm", sampleRate: 24_000, channels: 1 },
      textInput: true,
      ...(options.handsFree ? { turnDetection: "server_vad" as const } : {}),
      sessionControls: ["look_screen", "look_camera", "look_stop"],
      ...(options.lookFrames ? { lookFrames: true } : {}),
    },
    sendFrame: mock(async (payload) => {
      const frame = sequencer.next(payload);
      frames.push(frame);
      return frame;
    }),
  };

  const turns: VoiceTurnOptions[] = [];
  const startVoiceTurn = mock(async (turnOptions: VoiceTurnOptions) => {
    turns.push(turnOptions);
    return {
      turnId: `bridge-turn-${turns.length}`,
      abort: mock(),
      discard: mock(async () => {}),
    };
  });
  const streamTtsAudio: LiveVoiceTtsStreamer = mock(
    async (ttsOptions: LiveVoiceTtsOptions) => ({
      provider: "fish-audio" as const,
      contentType: "audio/pcm",
      sampleRate: 24_000,
      chunks: 1,
      bytes: Buffer.byteLength(ttsOptions.text),
    }),
  );

  let turnCount = 0;
  const transcribers: MockStreamingTranscriber[] = [];
  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(async () => {
      const transcriber = new MockStreamingTranscriber(
        options.handsFree ? "" : (options.request ?? "look at my screen"),
      );
      transcribers.push(transcriber);
      return transcriber;
    }),
    startVoiceTurn,
    streamTtsAudio,
    createTurnId: () => `live-turn-${++turnCount}`,
    emitMetrics: false,
    turnDetectorConfig: { silenceThresholdMs: 40 },
    frontModelConfig: { endpointDecisionTimeoutMs: 5_000 },
  });

  const callbacks = (index: number): VoiceTurnCallbacks | undefined =>
    turns[index]?.callbacks;

  const emitReply = (index: number, text: string): void => {
    const turnCallbacks = callbacks(index);
    turnCallbacks?.assistant_text_delta?.({
      type: "assistant_text_delta",
      text,
      conversationId: conversation.id,
    });
    turnCallbacks?.message_complete?.({
      type: "message_complete",
      conversationId: conversation.id,
      messageId: `assistant-message-${index}`,
    });
  };

  /** Finish turn `index` with `text` and wait for its speech to drain. */
  const reply = async (index: number, text: string): Promise<void> => {
    const doneCount =
      frames.filter((frame) => frame.type === "tts_done").length + 1;
    emitReply(index, text);
    await waitFor(
      () =>
        frames.filter((frame) => frame.type === "tts_done").length >= doneCount,
      { message: `Timed out waiting for turn ${index} to drain` },
    );
  };

  /** Ask for a look, and wait for the control to reach the client. */
  const askForLook = async (): Promise<void> => {
    await session.start();
    await session.handleClientFrame(
      options.handsFree
        ? { type: "text", text: options.request ?? "look at my screen" }
        : { type: "ptt_release" },
    );
    await waitFor(() => turns.length === 1, {
      message: "Timed out waiting for the spoken turn",
    });
    await reply(0, "Taking a look. [LOOK:SCREEN]");
    await waitFor(
      () => frames.some((frame) => frame.type === "session_control"),
      { message: "Timed out waiting for the look control" },
    );
  };

  /** Send a real kept frame with the given timing reason. */
  const sendFrame = async (reason: string): Promise<void> => {
    const attachment = await uploadAttachment(
      "frame.png",
      "image/png",
      IMAGE_BASE64,
    );
    const before = getMessages(conversation.id).length;
    await session.handleClientFrame({
      type: "sight_frame",
      attachmentId: attachment.id,
      timing: {
        reason,
        keepToEncodedMs: 1,
        encodedToUploadedMs: 1,
        uploadedToSentMs: 0,
        bytes: 1,
      },
    });
    await waitFor(() => getMessages(conversation.id).length > before, {
      message: "Timed out waiting for the frame to persist",
    });
  };

  return {
    frames,
    session,
    turns,
    transcribers,
    emitReply,
    reply,
    askForLook,
    sendFrame,
    dispose: async () => {
      await session.close("client_end");
      deleteConversation(conversation.id);
      activeConversation.dispose();
    },
  };
}

/** Long enough for a follow-up that was going to start to have started. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 600));
}

describe("live-voice look follow-up", () => {
  test("answers the look from its frame on a hidden turn of its own", async () => {
    const harness = createHarness({ lookFrames: true });
    try {
      await harness.askForLook();
      expect(harness.turns).toHaveLength(1);

      await harness.sendFrame(LOOK_FRAME_REASON);
      await waitFor(() => harness.turns.length === 2, {
        message: "Timed out waiting for the look to be answered",
      });

      const followUp = harness.turns[1];
      expect(followUp?.content).toBe(LOOK_FOLLOW_UP_CONTENT);
      expect(followUp?.hiddenSyntheticPrompt).toBe(true);
      expect(followUp?.routingUtterance).toBe("look at my screen");
      expect(followUp?.voiceControlPrompt).toContain(
        "You just took a fresh look at their screen",
      );
    } finally {
      await harness.dispose();
    }
  });

  test("carries an annotation request through capture and escalation", async () => {
    const request = "Show me on my screen where to add a new page.";
    const harness = createHarness({ lookFrames: true, request });
    try {
      await harness.askForLook();
      expect(harness.turns).toHaveLength(1);
      expect(harness.turns[0]?.routingUtterance).toBeUndefined();

      await harness.sendFrame(LOOK_FRAME_REASON);
      await waitFor(() => harness.turns.length === 2);
      const followUp = harness.turns[1];
      expect(followUp?.routingLeg).toBe("front-door");
      expect(followUp?.routingUtterance).toBe(request);
      expect(followUp?.voiceControlPrompt).toContain(JSON.stringify(request));
      expect(followUp?.voiceControlPrompt).toContain("screen-annotation tools");

      harness.emitReply(1, "[1] I'll point out the new page button.");
      await waitFor(() => harness.turns.length === 3);
      const escalated = harness.turns[2];
      expect(escalated?.routingLeg).toBe("escalated");
      expect(escalated?.content).toBe(ESCALATION_CONTINUATION_CONTENT);
      expect(escalated?.routingUtterance).toBe(request);
      expect(escalated?.voiceControlPrompt).toContain(JSON.stringify(request));
      expect(escalated?.voiceControlPrompt).toContain(
        "screen-annotation tools",
      );
      await harness.reply(2, "The new page button is highlighted.");
    } finally {
      await harness.dispose();
    }
  });

  test("an observation can answer from the fresh frame without escalating", async () => {
    const request = "What do you see on my screen?";
    const harness = createHarness({ lookFrames: true, request });
    try {
      await harness.askForLook();
      await harness.sendFrame(LOOK_FRAME_REASON);
      await waitFor(() => harness.turns.length === 2);
      expect(harness.turns[1]?.routingUtterance).toBe(request);
      await harness.reply(1, "There is a page editor with an empty document.");
      expect(harness.turns).toHaveLength(2);
    } finally {
      await harness.dispose();
    }
  });

  test("the reply that asks for a look is taught to only acknowledge it", async () => {
    const harness = createHarness({ lookFrames: true });
    try {
      await harness.askForLook();
      expect(harness.turns[0]?.voiceControlPrompt).toContain(
        "Use it even when their screen is already shared with you",
      );
    } finally {
      await harness.dispose();
    }
  });

  test("a client that did not declare lookFrames keeps the old look", async () => {
    const harness = createHarness({ lookFrames: false });
    try {
      await harness.askForLook();
      expect(harness.turns[0]?.voiceControlPrompt).toContain(
        "say you will take it from their next words",
      );

      await harness.sendFrame(LOOK_FRAME_REASON);
      await settle();
      expect(harness.turns).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });

  test("an ambient frame does not answer the look", async () => {
    const harness = createHarness({ lookFrames: true });
    try {
      await harness.askForLook();
      await harness.sendFrame("heartbeat");
      await settle();
      expect(harness.turns).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });

  // The turn started before the frame was in the conversation, so it could
  // not have read it: the look is still owed an answer once that turn is done.
  test("keeps a clarification from a turn started before the frame landed", async () => {
    const harness = createHarness({ lookFrames: true });
    try {
      await harness.askForLook();
      await harness.session.handleClientFrame({
        type: "text",
        text: "show me where to click",
      });
      await waitFor(() => harness.turns.length === 2, {
        message: "Timed out waiting for the typed turn",
      });

      await harness.sendFrame(LOOK_FRAME_REASON);
      await harness.reply(1, "Which one do you mean?");
      await waitFor(() => harness.turns.length === 3, {
        timeoutMs: 2_000,
        message: "Timed out waiting for the look to be answered",
      });
      expect(harness.turns[2]?.content).toBe(LOOK_FOLLOW_UP_CONTENT);
      const request = "look at my screen\nshow me where to click";
      expect(harness.turns[2]?.routingUtterance).toBe(request);
      expect(harness.turns[2]?.voiceControlPrompt).toContain(
        JSON.stringify(request),
      );
    } finally {
      await harness.dispose();
    }
  });

  test("keeps multiple caller clarifications in order", async () => {
    const harness = createHarness({ lookFrames: true });
    try {
      await harness.askForLook();
      const clarifications = ["show me where to click", "the new page button"];
      for (const [index, text] of clarifications.entries()) {
        await harness.session.handleClientFrame({ type: "text", text });
        await waitFor(() => harness.turns.length === index + 2);
        await harness.reply(index + 1, "I'm waiting for the screen view.");
      }
      await harness.sendFrame(LOOK_FRAME_REASON);
      await waitFor(() => harness.turns.length === 4);
      expect(harness.turns[3]?.routingUtterance).toBe(
        ["look at my screen", ...clarifications].join("\n"),
      );
    } finally {
      await harness.dispose();
    }
  });

  test("keeps a speculative clarification that commits after the frame lands", async () => {
    const harness = createHarness({ lookFrames: true, handsFree: true });
    try {
      await harness.askForLook();
      const audio = Buffer.alloc(480);
      for (let index = 0; index < 240; index += 1) {
        audio.writeInt16LE(8_000, index * 2);
      }
      await harness.session.handleBinaryAudio(audio);
      await waitFor(() => harness.transcribers.at(-1)?.stopped === false);
      harness.transcribers.at(-1)?.emitPartial("show me where to click");
      await waitFor(() => harness.turns.length === 2);
      expect(harness.turns[1]?.unifiedVerdict).toBe(true);

      await harness.sendFrame(LOOK_FRAME_REASON);
      await harness.reply(1, "I'll use the view when it arrives.");
      await waitFor(() => harness.turns.length === 3);
      expect(harness.turns[2]?.routingUtterance).toBe(
        "look at my screen\nshow me where to click",
      );
    } finally {
      await harness.dispose();
    }
  });

  test("duplicate look frames do not schedule a second follow-up", async () => {
    const harness = createHarness({ lookFrames: true });
    try {
      await harness.askForLook();
      await harness.session.handleClientFrame({
        type: "text",
        text: "show me where to click",
      });
      await waitFor(() => harness.turns.length === 2);
      await harness.sendFrame(LOOK_FRAME_REASON);
      await harness.sendFrame(LOOK_FRAME_REASON);
      await harness.reply(1, "Let me use that view.");
      await waitFor(() => harness.turns.length === 3);
      await harness.reply(2, "The button is at the top.");
      await settle();
      expect(harness.turns).toHaveLength(3);
    } finally {
      await harness.dispose();
    }
  });

  test("a turn that starts after the frame landed is not answered twice", async () => {
    const harness = createHarness({ lookFrames: true });
    try {
      await harness.askForLook();
      await harness.session.handleClientFrame({
        type: "text",
        text: "the second dropdown",
      });
      await waitFor(() => harness.turns.length === 2, {
        message: "Timed out waiting for the typed turn",
      });

      // Lands while the typed turn holds the floor, so the look waits.
      await harness.sendFrame(LOOK_FRAME_REASON);
      await harness.reply(1, "Which one do you mean?");
      // The user's next turn starts before the look's wait checks again, and
      // it reads the frame that is now in the conversation.
      await harness.session.handleClientFrame({
        type: "text",
        text: "the plan picker",
      });
      await waitFor(() => harness.turns.length === 3, {
        message: "Timed out waiting for the second typed turn",
      });
      await harness.reply(2, "That one sets the billing plan.");
      await settle();

      expect(harness.turns).toHaveLength(3);
      expect(harness.turns[2]?.content).toBe("the plan picker");
    } finally {
      await harness.dispose();
    }
  });

  test("an interrupt drops a look still waiting on its frame", async () => {
    const harness = createHarness({ lookFrames: true });
    try {
      await harness.askForLook();
      await harness.session.handleClientFrame({ type: "interrupt" });

      await harness.sendFrame(LOOK_FRAME_REASON);
      await settle();
      expect(harness.turns).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });

  test("an interrupt drops a captured look waiting for another turn to finish", async () => {
    const harness = createHarness({ lookFrames: true });
    try {
      await harness.askForLook();
      await harness.session.handleClientFrame({
        type: "text",
        text: "show me where to click",
      });
      await waitFor(() => harness.turns.length === 2);
      await harness.sendFrame(LOOK_FRAME_REASON);
      await harness.session.handleClientFrame({ type: "interrupt" });
      await settle();
      expect(harness.turns).toHaveLength(2);
    } finally {
      await harness.dispose();
    }
  });

  test("the turn that answers a look cannot chain another look", async () => {
    const harness = createHarness({ lookFrames: true });
    try {
      await harness.askForLook();
      await harness.sendFrame(LOOK_FRAME_REASON);
      await waitFor(() => harness.turns.length === 2, {
        message: "Timed out waiting for the look to be answered",
      });

      await harness.reply(1, "It is the plan picker. [LOOK:SCREEN]");
      await harness.sendFrame(LOOK_FRAME_REASON);
      await settle();
      expect(harness.turns).toHaveLength(2);
    } finally {
      await harness.dispose();
    }
  });
});
