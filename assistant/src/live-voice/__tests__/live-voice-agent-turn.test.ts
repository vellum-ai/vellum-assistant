/**
 * Session-orchestration tests for the duplex LiveVoiceSession composition
 * root. The three collaborators (ingest, transport, controller) are
 * injected as fakes (see live-voice-session-harness.ts) so these tests
 * exercise only the session's own responsibilities: frame emission and
 * ordering, turn lifecycle, barge-in routing, and teardown. End-to-end
 * behavior with the real collaborators lives in
 * live-voice-integration.test.ts.
 */

import { describe, expect, test } from "bun:test";

import { LiveVoiceSessionStartupError } from "../live-voice-session-manager.js";
import {
  audioFrame,
  createSessionHarness,
  frameTypes,
  START_FRAME,
  startRespondingTurn,
  waitFor,
} from "./live-voice-session-harness.js";

describe("LiveVoiceSession duplex orchestration", () => {
  test("start wires collaborators with the in-app session source and sends ready", async () => {
    const { session, frames, ingest, controller } = createSessionHarness();

    await session.start();

    expect(frames).toEqual([
      {
        type: "ready",
        seq: 1,
        sessionId: "session-123",
        conversationId: "conversation-123",
      },
    ]);
    expect(ingest.started).toBe(true);
    expect(ingest.config).toMatchObject({
      sampleRate: 24_000,
      mode: "ptt",
      vad: {
        speechEnergyThreshold: expect.any(Number),
        silenceThresholdMs: expect.any(Number),
        maxTurnDurationMs: expect.any(Number),
      },
    });
    expect(controller.options?.callSessionId).toBe("session-123");
    const sessionSource = controller.options?.sessionSource;
    expect(sessionSource?.conversationId).toBe("conversation-123");
    expect(sessionSource?.skipDisclosure).toBe(true);
    expect(sessionSource?.getSnapshot()).toMatchObject({
      status: "in_progress",
      conversationId: "conversation-123",
      initiatedFromConversationId: null,
    });
  });

  test("start frame mode overrides the configured default", async () => {
    const { session, ingest } = createSessionHarness({
      startFrame: { ...START_FRAME, mode: "open-mic" },
    });

    await session.start();

    expect(ingest.config?.mode).toBe("open-mic");
  });

  test("falls back to the session id when start omits a conversation id", async () => {
    const { session, frames, controller } = createSessionHarness({
      startFrame: { type: "start", audio: START_FRAME.audio },
    });

    await session.start();

    expect(frames[0]).toMatchObject({
      type: "ready",
      conversationId: "session-123",
    });
    expect(controller.options?.sessionSource.conversationId).toBe(
      "session-123",
    );
  });

  test("credential preflight not-ready fails startup with credentials_missing", async () => {
    const { session, frames, ingest, controller } = createSessionHarness({
      sessionOptions: {
        credentialPreflight: async () => ({
          status: "not-ready",
          missing: [
            { kind: "tts", providerId: "fish-audio", reason: "no key" },
          ],
          userMessage: "Live voice is unavailable because it requires a key.",
        }),
      },
    });

    await expect(session.start()).rejects.toBeInstanceOf(
      LiveVoiceSessionStartupError,
    );

    expect(frames).toEqual([
      {
        type: "error",
        seq: 1,
        code: "credentials_missing",
        message: "Live voice is unavailable because it requires a key.",
      },
    ]);
    expect(ingest.started).toBe(false);
    expect(controller.options).toBeNull();
  });

  test("credential preflight failure fails startup with credentials_missing", async () => {
    const { session, frames } = createSessionHarness({
      sessionOptions: {
        credentialPreflight: async () => {
          throw new Error("credential store offline");
        },
      },
    });

    await expect(session.start()).rejects.toBeInstanceOf(
      LiveVoiceSessionStartupError,
    );
    expect(frames[0]).toMatchObject({
      type: "error",
      code: "credentials_missing",
      message: expect.stringContaining("credential store offline"),
    });
  });

  test("routes JSON and binary audio to the ingest", async () => {
    const { session, ingest } = createSessionHarness();

    await session.start();
    await session.handleClientFrame(audioFrame("json bytes"));
    await session.handleBinaryAudio(new Uint8Array([1, 2, 3]));

    expect(ingest.pushed.map((chunk) => [...chunk])).toEqual([
      [...Buffer.from("json bytes")],
      [1, 2, 3],
    ]);
  });

  test("audio is accepted in every non-closed state — no post-release rejection", async () => {
    // Regression for the removed V1 terminal ptt_release behavior: audio
    // arriving after ptt_release (and after a completed assistant turn)
    // must flow to the ingest instead of producing invalid_audio_payload.
    const harness = createSessionHarness();
    const { session, frames, ingest, transport } = harness;

    await startRespondingTurn(harness);
    await session.handleClientFrame({ type: "ptt_release" });
    await session.handleClientFrame(audioFrame("during response"));

    await transport.emitTtsDone();
    await session.handleClientFrame(audioFrame("after tts_done"));
    await session.handleBinaryAudio(new Uint8Array([9]));

    expect(ingest.pushed).toHaveLength(4);
    expect(frames.filter((frame) => frame.type === "error")).toEqual([]);
  });

  test("final transcripts dispatch to the controller with stt_final and thinking frames", async () => {
    const harness = createSessionHarness();
    const { frames, controller } = harness;

    await startRespondingTurn(harness, "hello world");

    expect(controller.utterances).toEqual(["hello world"]);
    expect(frameTypes(frames)).toEqual(["ready", "stt_final", "thinking"]);
    expect(frames[2]).toMatchObject({
      type: "thinking",
      turnId: "live-turn-1",
    });
  });

  test("empty final transcripts cancel the listening turn with a turn_cancelled notice", async () => {
    const harness = createSessionHarness({ emitMetrics: true });
    const { session, frames, ingest, controller } = harness;

    await session.start();
    await session.handleClientFrame(audioFrame("noise"));
    ingest.callbacks.onTranscriptFinal?.("   \n\t ");
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_cancelled",
      ),
    );

    expect(controller.utterances).toEqual([]);
    expect(frames.some((frame) => frame.type === "thinking")).toBe(false);
    // The client is told the turn died so it resumes listening.
    expect(
      frames.find((frame) => frame.type === "turn_cancelled"),
    ).toMatchObject({ type: "turn_cancelled", reason: "empty_transcript" });
  });

  test("a failed assistant turn emits turn_failed and cancels the turn", async () => {
    const harness = createSessionHarness({ emitMetrics: true });
    const { session, frames, ingest, controller } = harness;

    controller.handleCallerUtterance = async () => {
      throw new Error("pipeline exploded");
    };

    await session.start();
    await session.handleClientFrame(audioFrame("user audio"));
    ingest.callbacks.onTranscriptFinal?.("hello there");
    await waitFor(() =>
      frames.some((frame) => frame.type === "turn_cancelled"),
    );

    expect(frames.find((frame) => frame.type === "error")).toMatchObject({
      type: "error",
      code: "turn_failed",
      message: expect.stringContaining("pipeline exploded"),
    });
    expect(
      frames.find((frame) => frame.type === "turn_cancelled"),
    ).toMatchObject({ reason: "turn_failed" });
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_cancelled",
      ),
    );
  });

  test("transcription errors carry the stt_failed code", async () => {
    const { session, frames, ingest } = createSessionHarness();

    await session.start();
    ingest.callbacks.onError?.("stream", "provider connection dropped");
    await waitFor(() => frames.some((frame) => frame.type === "error"));

    expect(frames.find((frame) => frame.type === "error")).toMatchObject({
      code: "stt_failed",
      message: expect.stringContaining("provider connection dropped"),
    });
  });

  test("forwards partials and turn boundaries", async () => {
    const { session, frames, ingest } = createSessionHarness();

    await session.start();
    ingest.callbacks.onPartial?.("hel");
    ingest.callbacks.onTurnBoundary?.();
    await waitFor(() => frames.length >= 3);

    expect(frameTypes(frames)).toEqual([
      "ready",
      "stt_partial",
      "turn_boundary",
    ]);
    expect(frames[1]).toMatchObject({ type: "stt_partial", text: "hel" });
  });

  test("ptt_release forces the ingest turn to end", async () => {
    const { session, ingest } = createSessionHarness();

    await session.start();
    await session.handleClientFrame({ type: "ptt_release" });

    expect(ingest.forceTurnEndCount).toBe(1);
  });

  test("assistant tokens emit assistant_text_delta frames and reach the real transport", async () => {
    const harness = createSessionHarness();
    const { frames, transport, controllerTransport } = harness;

    await startRespondingTurn(harness);
    controllerTransport().sendTextToken("Hello ", false);
    controllerTransport().sendTextToken("there.", true);
    await waitFor(
      () =>
        frames.filter((frame) => frame.type === "assistant_text_delta")
          .length === 2,
    );

    expect(
      frames
        .filter((frame) => frame.type === "assistant_text_delta")
        .map((frame) =>
          frame.type === "assistant_text_delta" ? frame.text : "",
        ),
    ).toEqual(["Hello ", "there."]);
    expect(transport.tokens).toEqual([
      { token: "Hello ", last: false },
      { token: "there.", last: true },
    ]);
  });

  test("tts_done completes the turn and later turns keep seq strictly increasing", async () => {
    const harness = createSessionHarness();
    const { session, frames, ingest, transport, controller } = harness;

    await startRespondingTurn(harness, "first utterance");
    await transport.emitTtsAudio("audio one");
    await transport.emitTtsDone();

    controller.state = "idle";
    await session.handleClientFrame(audioFrame("second audio"));
    ingest.callbacks.onTranscriptFinal?.("second utterance");
    await waitFor(
      () => frames.filter((frame) => frame.type === "thinking").length === 2,
    );
    await transport.emitTtsAudio("audio two");
    await transport.emitTtsDone();

    expect(controller.utterances).toEqual([
      "first utterance",
      "second utterance",
    ]);
    expect(frameTypes(frames)).toEqual([
      "ready",
      "stt_final",
      "thinking",
      "tts_audio",
      "tts_done",
      "stt_final",
      "thinking",
      "tts_audio",
      "tts_done",
    ]);
    expect(frames.find((frame) => frame.type === "tts_done")).toMatchObject({
      turnId: "live-turn-1",
    });
    expect(
      frames.filter((frame) => frame.type === "tts_done").at(-1),
    ).toMatchObject({ turnId: "live-turn-2" });
    const seqs = frames.map((frame) => frame.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("speech onset during assistant speech barges in and emits interrupted", async () => {
    const harness = createSessionHarness();
    const { session, frames, ingest, transport, controller } = harness;

    await startRespondingTurn(harness);
    controller.state = "speaking";
    ingest.callbacks.onSpeechStart?.();
    await waitFor(() => frames.some((frame) => frame.type === "interrupted"));

    expect(controller.bargeInCount).toBe(1);
    expect(frames.find((frame) => frame.type === "interrupted")).toMatchObject({
      type: "interrupted",
      turnId: "live-turn-1",
    });

    // The controller's barge-in unwind still emits a tts_done for the
    // aborted turn; the session must drop it instead of forwarding it or
    // completing the next turn with it.
    await transport.emitTtsDone("live-turn-1");
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);

    // The next utterance opens a fresh turn.
    await session.handleClientFrame(audioFrame("follow-up audio"));
    ingest.callbacks.onTranscriptFinal?.("follow up");
    await waitFor(
      () => frames.filter((frame) => frame.type === "thinking").length === 2,
    );
    expect(
      frames.filter((frame) => frame.type === "thinking").at(-1),
    ).toMatchObject({ turnId: "live-turn-2" });
  });

  test("speech onset while the assistant is idle or processing is not a barge-in", async () => {
    const harness = createSessionHarness();
    const { ingest, frames, controller } = harness;

    await harness.session.start();
    ingest.callbacks.onSpeechStart?.();
    controller.state = "processing";
    ingest.callbacks.onSpeechStart?.();

    expect(controller.bargeInCount).toBe(0);
    expect(frames.some((frame) => frame.type === "interrupted")).toBe(false);
  });

  test("client interrupt frame follows the same barge-in path", async () => {
    const harness = createSessionHarness();
    const { session, frames, controller } = harness;

    await startRespondingTurn(harness);

    // Not speaking: no-op.
    await session.handleClientFrame({ type: "interrupt" });
    expect(frames.some((frame) => frame.type === "interrupted")).toBe(false);

    controller.state = "speaking";
    await session.handleClientFrame({ type: "interrupt" });
    await waitFor(() => frames.some((frame) => frame.type === "interrupted"));
    expect(controller.bargeInCount).toBe(1);
  });

  test("a final arriving while the assistant responds supersedes the turn", async () => {
    const harness = createSessionHarness({ emitMetrics: true });
    const { frames, ingest, controller } = harness;

    await startRespondingTurn(harness, "first utterance");
    ingest.callbacks.onTranscriptFinal?.("actually, this instead");
    await waitFor(
      () => frames.filter((frame) => frame.type === "thinking").length === 2,
    );

    expect(controller.utterances).toEqual([
      "first utterance",
      "actually, this instead",
    ]);
    expect(
      frames.filter((frame) => frame.type === "thinking").at(-1),
    ).toMatchObject({ turnId: "live-turn-2" });
    expect(
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_cancelled",
      ),
    ).toBe(true);
  });

  test("controller endSession emits session_ended, closes the session, and stops accepting input", async () => {
    const harness = createSessionHarness({ emitMetrics: true });
    const { session, frames, ingest, transport, controller } = harness;

    await session.start();
    transport.endSession("Call completed");
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "session_ended",
      ),
    );

    expect(ingest.stopCount).toBe(1);
    expect(ingest.disposed).toBe(true);
    expect(controller.destroyed).toBe(true);

    // The client is told the session ended (with the controller's reason)
    // before the final metrics frame.
    const sessionEndedIndex = frames.findIndex(
      (frame) => frame.type === "session_ended",
    );
    expect(frames[sessionEndedIndex]).toMatchObject({
      type: "session_ended",
      reason: "Call completed",
    });
    expect(sessionEndedIndex).toBeLessThan(
      frames.findIndex(
        (frame) => frame.type === "metrics" && frame.event === "session_ended",
      ),
    );

    const pushedBefore = ingest.pushed.length;
    await session.handleClientFrame(audioFrame("late audio"));
    expect(ingest.pushed).toHaveLength(pushedBefore);
    expect(frames.filter((frame) => frame.type === "error")).toEqual([]);
  });

  test("server-initiated end drains the TTS queue (goodbye) before session_ended and close", async () => {
    const harness = createSessionHarness({ emitMetrics: true });
    const { session, frames, ingest, transport } = harness;

    await session.start();
    let releaseDrain!: () => void;
    transport.ttsDrainGate = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });

    transport.endSession("Call completed");
    // Give the async end flow time to (incorrectly) race ahead.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The goodbye is still synthesizing: nothing torn down, nothing sent.
    expect(transport.ttsDrainWaits).toBe(1);
    expect(frames.some((frame) => frame.type === "session_ended")).toBe(false);
    expect(ingest.disposed).toBe(false);

    releaseDrain();
    await waitFor(() => frames.some((frame) => frame.type === "session_ended"));
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "session_ended",
      ),
    );
    expect(ingest.disposed).toBe(true);
  });

  test("interrupt during the synthesis tail (controller already idle) cancels the turn at the session layer", async () => {
    const harness = createSessionHarness({ emitMetrics: true });
    const { session, frames, transport, controller } = harness;

    await startRespondingTurn(harness);
    // Generation finished: the controller went idle, but the transport's
    // synthesis tail is still playing (no tts_done processed yet).
    controller.state = "idle";

    await session.handleClientFrame({ type: "interrupt" });
    await waitFor(() => frames.some((frame) => frame.type === "interrupted"));

    // The controller rejected the barge-in (not speaking); the session
    // flushed the tail itself.
    expect(controller.bargeInCount).toBe(0);
    expect(transport.discardCount).toBe(1);
    expect(frames.find((frame) => frame.type === "interrupted")).toMatchObject({
      turnId: "live-turn-1",
    });
    await waitFor(() =>
      frames.some(
        (frame) => frame.type === "metrics" && frame.event === "turn_cancelled",
      ),
    );

    // A straggler tts_done from the aborted tail is dropped.
    await transport.emitTtsDone("live-turn-1");
    expect(frames.some((frame) => frame.type === "tts_done")).toBe(false);
  });

  test("speech onset during the synthesis tail triggers the session-level interrupt", async () => {
    const harness = createSessionHarness();
    const { frames, ingest, transport, controller } = harness;

    await startRespondingTurn(harness);
    controller.state = "idle";

    ingest.callbacks.onSpeechStart?.();
    await waitFor(() => frames.some((frame) => frame.type === "interrupted"));

    expect(controller.bargeInCount).toBe(0);
    expect(transport.discardCount).toBe(1);
  });

  test("close tears down collaborators, cancels the open turn, and emits session_ended", async () => {
    const harness = createSessionHarness({ emitMetrics: true });
    const { session, frames, ingest, controller } = harness;

    await startRespondingTurn(harness);
    await session.close("websocket_close");

    expect(ingest.stopCount).toBe(1);
    expect(ingest.disposed).toBe(true);
    expect(controller.destroyed).toBe(true);
    const metricsEvents = frames
      .filter((frame) => frame.type === "metrics")
      .map((frame) => (frame.type === "metrics" ? frame.event : ""));
    expect(metricsEvents).toEqual(["turn_cancelled", "session_ended"]);

    // Close is idempotent.
    await session.close("manager_shutdown");
    expect(ingest.stopCount).toBe(1);
  });
});
