/**
 * Ambient floating transcript for the voice room — muted, secondary text that
 * hovers near the centered avatar without ever becoming a chat bubble or
 * displacing the avatar. Two independently pref-gated halves:
 *
 * - USER speech ABOVE the avatar — `partialTranscript || finalTranscript` from
 *   the live-voice store, shown only when `showUserTranscript` is on.
 * - ASSISTANT speech BELOW the avatar — `assistantTranscript`, shown only when
 *   `showAssistantTranscript` is on.
 *
 * Both prefs default OFF, so by default this renders nothing and the room stays
 * text-free. The avatar (centered by the room) is the primary anchor; each half
 * is absolutely positioned relative to the room overlay so text appearing or
 * clearing never shifts the avatar.
 *
 * Subscriptions are deliberately narrow — only the three transcript fields and
 * the two prefs — so the high-frequency `inputAmplitude` (and `state`) churn on
 * the live-voice store never re-renders this component. The full transcript
 * still lands in the chat thread on exit via the engine path; this is a live,
 * ambient echo only.
 */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { cn } from "@vellumai/design-library";

import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

/** Shared muted, constrained-width, centered treatment for both halves. */
const AMBIENT_TEXT_CLASS =
  "pointer-events-none absolute left-1/2 z-0 max-w-[32rem] -translate-x-1/2 px-6 text-center text-sm text-balance whitespace-pre-wrap break-words text-[var(--content-tertiary)]";

export function VoiceAmbientTranscript() {
  const showUser = useVoicePrefsStore.use.showUserTranscript();
  const showAssistant = useVoicePrefsStore.use.showAssistantTranscript();

  const partialTranscript = useLiveVoiceStore.use.partialTranscript();
  const finalTranscript = useLiveVoiceStore.use.finalTranscript();
  const assistantTranscript = useLiveVoiceStore.use.assistantTranscript();
  const reduce = useReducedMotion();

  // In-flight partial wins over the last finalized transcript — same precedence
  // as the underneath composer transcript (`VoiceLiveTranscript`).
  const userText = partialTranscript || finalTranscript;

  const showUserHalf = showUser && userText.length > 0;
  const showAssistantHalf = showAssistant && assistantTranscript.length > 0;

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
          className={cn(AMBIENT_TEXT_CLASS, "bottom-[calc(50%+8.5rem)]")}
          {...fade}
        >
          {userText}
        </motion.p>
      ) : null}

      {showAssistantHalf ? (
        <motion.p
          key="assistant"
          data-testid="voice-ambient-assistant"
          aria-live="polite"
          // Below the centered avatar; top-anchored so it grows downward.
          className={cn(AMBIENT_TEXT_CLASS, "top-[calc(50%+8.5rem)]")}
          {...fade}
        >
          {assistantTranscript}
        </motion.p>
      ) : null}
    </AnimatePresence>
  );
}
