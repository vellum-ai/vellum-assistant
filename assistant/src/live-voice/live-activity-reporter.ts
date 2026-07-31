/**
 * Reports a live-voice session's phase to the platform, which pushes it to the
 * iOS Live Activity over APNs.
 *
 * ## Why the server reports a phase the client already knows
 *
 * Every phase the island shows is derived, client-side, from frames this
 * session sends: `utterance_ended` → transcribing, `stt_final`/`thinking` →
 * thinking, the first `tts_audio` → speaking. The web layer then pushes that
 * phase to ActivityKit itself, which works perfectly — right up to the moment
 * the app is backgrounded, which is the only moment the Lock Screen and the
 * Dynamic Island are on screen at all. iOS throttles and eventually suspends
 * that web view, and a suspended web view cannot report anything.
 *
 * So the same derivation runs here, on the side of the connection that stays
 * up. This is deliberately a *mirror* of the client's mapping rather than a new
 * source of truth: {@link phaseForFrame} and the client's frame handlers must
 * agree, and the client's remain authoritative for anything they can observe
 * that this cannot (a reconnect, a mute, whether TTS audio is actually
 * audible).
 *
 * ## Everything here is best-effort
 *
 * A voice session must be entirely unaffected by this. Every failure is logged
 * and dropped: no retry, no backpressure, and never a throw into the session's
 * frame path. A missed island update costs a stale label for a few seconds; a
 * throw here would cost the conversation.
 */

import { VellumPlatformClient } from "../platform/client.js";
import { getLogger } from "../util/logger.js";
import type { LiveVoiceServerFramePayload } from "./protocol.js";

const log = getLogger("live-activity-reporter");

/** The phases an iOS Live Activity can render. Mirrors the client's union. */
export type LiveActivityPhase =
  | "connecting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "ending";

/**
 * The phase a frame puts the session into, or `null` for frames that do not
 * move it.
 *
 * `frame` is typed as the protocol's own payload union rather than a bare
 * string, so a `case` for a frame that does not exist is a compile error. The
 * first version of this function matched `"utterance_ended"` — a frame no part
 * of the system emits — and silently never fired.
 *
 * **This mirrors the client's handlers** in
 * `clients/web/src/domains/chat/voice/live-voice/use-live-voice.ts`, which stay
 * authoritative. Frames absent here are not oversights: most say nothing about
 * the phase (`stt_partial` streams inside `listening`, and every `tts_audio`
 * after the first is already `speaking`).
 *
 * `lastPhase` is a parameter because two of the client's rules are stateful,
 * and dropping them would put wrong wording on a Lock Screen the user cannot
 * correct.
 */
export function phaseForFrame(
  frame: LiveVoiceServerFramePayload,
  lastPhase: LiveActivityPhase | null,
): LiveActivityPhase | null {
  switch (frame.type) {
    case "utterance_end":
      return "transcribing";
    case "utterance_discarded":
      // The utterance held no usable speech, so the turn never happens and the
      // session drops back to listening.
      return "listening";
    case "stt_final":
      // **Not every final means the assistant is thinking.** Semantic
      // endpointing can hold an utterance open past a final — the session
      // suppresses `utterance_end`, and the floor is still the user's — so
      // only a *closed* utterance advances. An empty final never starts a turn
      // either; its utterance is about to be discarded. Both conditions are
      // the client's, restated here only because this side cannot observe the
      // store: see the `sttFinal` handler in `use-live-voice.ts`.
      if (lastPhase !== "transcribing" || frame.text.trim().length === 0) {
        return null;
      }
      return "thinking";
    case "thinking":
      // Unconditional, unlike `stt_final`: the session sends this frame
      // precisely when it has committed to a turn.
      return "thinking";
    case "tts_audio":
      return "speaking";
    case "tts_done":
      // The assistant stopped talking; the floor is the user's again.
      return "listening";
    default:
      return null;
  }
}

/**
 * Pushes phase changes for one session, de-duplicating repeats.
 *
 * The de-duplication is not an optimization. `tts_audio` arrives per audio
 * chunk — many times a second — and ActivityKit rate-limits updates and drops
 * the overflow silently, so a reporter that forwarded every frame would spend
 * the session's whole update budget restating `speaking` and have none left
 * for the phase the user is waiting to see.
 */
export class LiveActivityReporter {
  private lastPhase: LiveActivityPhase | null = null;
  private ended = false;

  constructor(private readonly conversationId: string) {}

  /**
   * Report the phase a frame implies, if it changed. Fire-and-forget: callers
   * are on the session's send path and must not await this.
   */
  report(frame: LiveVoiceServerFramePayload): void {
    const phase = phaseForFrame(frame, this.lastPhase);
    if (phase === null || phase === this.lastPhase || this.ended) {
      return;
    }
    this.lastPhase = phase;
    void this.dispatch(phase, "update");
  }

  /**
   * Retire the activity as the session ends.
   *
   * Latched, because a session can end more than one way — a clean hangup, a
   * dropped socket, a process shutdown — and the platform deletes the
   * registration on the first one. Sending a second would push at an activity
   * that is already gone.
   */
  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    void this.dispatch("ending", "end");
  }

  /** `protected` so a test can observe what would be sent without sending it. */
  protected async dispatch(
    phase: LiveActivityPhase,
    event: "update" | "end",
  ): Promise<void> {
    try {
      const client = await VellumPlatformClient.create();
      if (!client?.platformAssistantId) {
        return;
      }
      const path = `/v1/assistants/${encodeURIComponent(
        client.platformAssistantId,
      )}/live-activity/dispatch/`;
      const response = await client.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: this.conversationId,
          phase,
          event,
        }),
      });
      if (!response.ok) {
        log.debug(
          { status: response.status, phase, event },
          "Live Activity dispatch rejected",
        );
      }
    } catch (err) {
      // Deliberately not retried. By the time a retry landed the phase would
      // have moved on, and re-sending a stale one is worse than sending
      // nothing — `aps.timestamp` would let it through as newer.
      log.debug({ err, phase, event }, "Live Activity dispatch failed");
    }
  }
}
