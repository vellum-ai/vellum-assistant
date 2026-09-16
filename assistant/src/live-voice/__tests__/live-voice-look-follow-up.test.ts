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

  async start(onEvent: (event: SttStreamServerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  sendAudio(): void {}

  stop(): void {
    this.onEvent?.({ type: "final", text: "look at my screen" });
    this.onEvent?.({ type: "closed" });
  }
}

function createHarness(options: { lookFrames: boolean }) {
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
    return { turnId: `bridge-turn-${turns.length}`, abort: mock() };
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
  const session = new LiveVoiceSession(context, {
    resolveTranscriber: mock(async () => new MockStreamingTranscriber()),
    startVoiceTurn,
    streamTtsAudio,
    createTurnId: () => `live-turn-${++turnCount}`,
    emitMetrics: false,
  });

  const callbacks = (index: number): VoiceTurnCallbacks | undefined =>
    turns[index]?.callbacks;

  /** Finish turn `index` with `text` and wait for its speech to drain. */
  const reply = async (index: number, text: string): Promise<void> => {
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
    const doneCount = index + 1;
    await waitFor(
      () =>
        frames.filter((frame) => frame.type === "tts_done").length >= doneCount,
      { message: `Timed out waiting for turn ${index} to drain` },
    );
  };

  /** Ask for a look, and wait for the control to reach the client. */
  const askForLook = async (): Promise<void> => {
    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });
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
      expect(followUp?.voiceControlPrompt).toContain(
        "You just took a fresh look at their screen",
      );
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
  test("a turn that started before the frame landed does not answer the look", async () => {
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

      await harness.sendFrame(LOOK_FRAME_REASON);
      await harness.reply(1, "Which one do you mean?");
      await waitFor(() => harness.turns.length === 3, {
        timeoutMs: 2_000,
        message: "Timed out waiting for the look to be answered",
      });
      expect(harness.turns[2]?.content).toBe(LOOK_FOLLOW_UP_CONTENT);
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
