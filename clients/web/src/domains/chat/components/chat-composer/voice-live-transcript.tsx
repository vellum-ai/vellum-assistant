/**
 * Display-only live transcript rendered in the composer's text area during a
 * live-voice session (Light 55): the user's speech streams in as normal
 * composer-styled text followed by a blinking caret. Not editable — the turn
 * auto-sends on silence/turn end (or via the voice bar's green ↑).
 *
 * Subscribes to the live-voice store itself via per-field selectors. This is
 * deliberate: the composer opts out of high-frequency live-voice updates
 * (`observeAudioState: false`), so per-delta transcript re-renders must stay
 * contained to this leaf component.
 *
 * Shows `partialTranscript || finalTranscript` — the in-flight partial wins
 * while both are present (same precedence as the old inline transcript
 * strip). When both are empty it renders nothing, letting the disabled
 * textarea's placeholder show through (Light 53 baseline).
 *
 * Clearing is store-driven: V1 resets transcripts per session; when the
 * engine lands multi-turn sessions the store clears per turn and this
 * component follows automatically — no turn logic lives here.
 */

import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";

import { cn } from "@vellumai/design-library";

import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";

export interface VoiceLiveTranscriptProps {
  /** Placement classes from the composer (e.g. the textarea's grid cell). */
  className?: string;
  /**
   * Cap for the transcript's auto-grow height — mirrors the textarea's
   * `textareaMaxHeightPx` so the swap preserves the composer's height
   * behavior; content beyond the cap scrolls.
   */
  maxHeightPx?: number;
}

export function VoiceLiveTranscript({
  className,
  maxHeightPx,
}: VoiceLiveTranscriptProps) {
  const partialTranscript = useLiveVoiceStore.use.partialTranscript();
  const finalTranscript = useLiveVoiceStore.use.finalTranscript();
  const reducedMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement | null>(null);

  const text = partialTranscript || finalTranscript;

  // Keep the newest words (and the caret) in view once the transcript
  // overflows the max height — mirrors how a textarea tracks its caret.
  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text]);

  if (!text) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      aria-live="polite"
      aria-label="Voice transcript"
      // Text styling matches the composer textarea exactly (same padding,
      // font class, and color) so speech reads as typed composer text.
      className={cn(
        "overflow-y-auto whitespace-pre-wrap break-words px-4 pt-3 pb-2 text-chat text-[var(--content-default)]",
        className,
      )}
      style={
        maxHeightPx !== undefined ? { maxHeight: `${maxHeightPx}px` } : undefined
      }
    >
      {text}
      <span
        aria-hidden
        data-testid="voice-transcript-caret"
        // Thin caret bar sized to the text's cap height; blinks via the
        // `voice-caret-blink` keyframes in index.css, held static under
        // reduced motion.
        className={cn(
          "ml-px inline-block h-[1.1em] w-[1.5px] translate-y-[0.2em] bg-[var(--content-default)]",
          !reducedMotion && "voice-caret-blink",
        )}
      />
    </div>
  );
}
