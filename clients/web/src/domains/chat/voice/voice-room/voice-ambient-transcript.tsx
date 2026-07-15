/**
 * Ambient floating transcript for the voice room — muted, secondary text that
 * hovers near the centered avatar without ever becoming a chat bubble or
 * displacing the avatar. Two independently pref-gated halves:
 *
 * - USER speech ABOVE the avatar — `partialTranscript || finalTranscript` from
 *   the live-voice store, shown only when `showUserTranscript` is on.
 * - ASSISTANT speech BELOW the avatar — `assistantTranscript`, shown only when
 *   `showAssistantTranscript` is on AND the assistant isn't idle behind a new
 *   `listening` turn (the transcript lingers until the next response starts, so
 *   without this it would sit under the low-sunk listening eyes).
 *
 * Both prefs default OFF, so by default this renders nothing and the room stays
 * text-free. The avatar (centered by the room) is the primary anchor; each half
 * is absolutely positioned relative to the room overlay so text appearing or
 * clearing never shifts the avatar. Words reveal one at a time via
 * {@link VoiceTranscriptText}, with a per-half clearance that keeps the text off
 * the centered eyes at any window size.
 *
 * Subscriptions are deliberately narrow — the three transcript fields, the two
 * prefs, and the low-frequency `state`/`reconnecting` (per-turn, for the
 * listening gate) — so the high-frequency `inputAmplitude` churn on the
 * live-voice store never re-renders this component. The full transcript still
 * lands in the chat thread on exit via the engine path; this is a live, ambient
 * echo only.
 */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

import { toVoiceAvatarVisual } from "./voice-avatar-state";
import { VoiceTranscriptText } from "./voice-transcript-text";

/**
 * Shared constrained-width, centered treatment for both halves. Base tone comes
 * from the per-word {@link VoiceTranscriptText} (room-fg-muted, leading word
 * brighter); this only owns layout + wrapping.
 */
const AMBIENT_TEXT_CLASS =
  "pointer-events-none absolute left-1/2 z-0 max-w-[38rem] -translate-x-1/2 px-6 text-center text-[clamp(19px,2.6vmin,30px)] leading-relaxed text-balance whitespace-pre-wrap break-words";

/**
 * Vertical clearance from the room center to each transcript half. The centered
 * eyes reach up to `EYE_TARGET_HEIGHT` (30%) of the smaller viewport dimension
 * tall — i.e. 15vmin above and below center — so anchoring the text past
 * `15vmin` plus a gap keeps it clear of the eyes (color look) and the centered
 * avatar (void look) at every window size, where the old fixed rem offset let
 * the big eyes ride into the text.
 */
const TRANSCRIPT_CLEARANCE = "calc(50% + 15vmin + 2.5rem)";

export function VoiceAmbientTranscript() {
  const showUser = useVoicePrefsStore.use.showUserTranscript();
  const showAssistant = useVoicePrefsStore.use.showAssistantTranscript();

  const partialTranscript = useLiveVoiceStore.use.partialTranscript();
  const finalTranscript = useLiveVoiceStore.use.finalTranscript();
  const assistantTranscript = useLiveVoiceStore.use.assistantTranscript();
  // Low-frequency (per-turn) fields — safe to subscribe to without the
  // `inputAmplitude` churn the narrow subscriptions above avoid.
  const state = useLiveVoiceStore.use.state();
  const reconnecting = useLiveVoiceStore.use.reconnecting();
  const assistantAudioActive = useLiveVoiceStore.use.assistantAudioActive();
  const reduce = useReducedMotion();

  // In-flight partial wins over the last finalized transcript — same precedence
  // as the underneath composer transcript (`VoiceLiveTranscript`).
  const userText = partialTranscript || finalTranscript;

  // The assistant transcript is only cleared when the NEXT response starts
  // thinking, so a finished response lingers in the store through the following
  // `listening` turn — where the eyes sink low, right onto the below-center
  // assistant caption. Hide that half while listening (the assistant isn't
  // speaking then anyway); in thinking/responding the eyes are centered and the
  // clearance clears them.
  const visual = toVoiceAvatarVisual(state, reconnecting, assistantAudioActive);
  const showUserHalf = showUser && userText.length > 0;
  const showAssistantHalf =
    showAssistant && assistantTranscript.length > 0 && visual !== "listening";

  const fade = {
    initial: reduce ? false : { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: reduce ? 0 : 0.3 },
  } as const;

  return (
    <AnimatePresence>
      {showUserHalf ? (
        <motion.p
          key="user"
          data-testid="voice-ambient-user"
          aria-live="polite"
          // Above the centered avatar; bottom-anchored so it grows upward and
          // never creeps toward the orb.
          className={AMBIENT_TEXT_CLASS}
          style={{ bottom: TRANSCRIPT_CLEARANCE }}
          {...fade}
        >
          <VoiceTranscriptText text={userText} />
        </motion.p>
      ) : null}

      {showAssistantHalf ? (
        <motion.p
          key="assistant"
          data-testid="voice-ambient-assistant"
          aria-live="polite"
          // Below the centered avatar; top-anchored so it grows downward.
          className={AMBIENT_TEXT_CLASS}
          style={{ top: TRANSCRIPT_CLEARANCE }}
          {...fade}
        >
          <VoiceTranscriptText text={assistantTranscript} />
        </motion.p>
      ) : null}
    </AnimatePresence>
  );
}
