/**
 * `LiveVoiceButton` — composer entry point for a live-voice conversation.
 *
 * Distinct from the dictation {@link import("./voice-input-button").VoiceInputButton}:
 * that one records a single utterance and drops a transcript into the composer,
 * while this one starts a full-duplex live-voice session (mic streaming + TTS
 * playback + barge-in).
 *
 * Purely presentational: the `useLiveVoice` controller lives in the
 * layout-mounted `useLiveVoiceSessionController`; the composer binds the
 * assistant/conversation into `onStart`, which drives the store-registered
 * session starter. While a session is active the owning composer swaps its
 * whole action row — this button included — for the `VoiceComposerBar`, whose
 * ✕ owns ending the session; in non-owning composers the button stays visible
 * but disabled, so this control never needs a stop affordance.
 */

import { AudioLines } from "lucide-react";

import {
  MOBILE_CONTROL_CLASS,
  MOBILE_GLYPH_CLASS,
} from "@/domains/chat/components/chat-composer/composer-mobile-chrome";
import { Button } from "@vellumai/design-library";

interface LiveVoiceButtonProps {
  /**
   * Start a live-voice session (the composer binds assistant + conversation).
   * Receives the button's viewport-space center so the room can grow its
   * entrance from where the user tapped.
   */
  onStart: (origin?: { x: number; y: number }) => void;
  /** Disable the control (e.g. while dictation is recording). */
  disabled?: boolean;
  /**
   * Render as the mobile composer row's send-slot control: a 40x40 filled
   * circle holding a 20px glyph. The composer drives this from the same
   * window-width signal that produces that row, so a phone and a window
   * dragged narrow get the same circle. Off by default, which leaves the
   * `Button` primitive's own sizing in charge.
   */
  mobileRow?: boolean;
}

export function LiveVoiceButton({
  onStart,
  disabled = false,
  mobileRow = false,
}: LiveVoiceButtonProps) {
  return (
    <Button
      // Filled `primary` (black) so the voice entry point carries the same
      // prominence as the send button it shares the composer's send slot with
      // (both `Button variant="primary"` icon-only, so identical footprint +
      // fill) — rather than a low-emphasis ghost that reads as secondary.
      variant="primary"
      iconOnly={<AudioLines strokeWidth={2} />}
      // The row's own signal sizes the circle, so the primitive's mobile growth
      // steps aside; the fill is the `primary` token the design's light circle
      // resolves to.
      iconOnlyGlyphClassName={mobileRow ? MOBILE_GLYPH_CLASS : undefined}
      expandOnMobile={!mobileRow}
      className={mobileRow ? MOBILE_CONTROL_CLASS : undefined}
      // Anchor for the in-chat tour's closing beat, which lands the assistant's
      // avatar on this control.
      data-tour-id="voice-mode"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onStart({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
      }}
      disabled={disabled}
      aria-label="Start voice mode"
      title="Start voice mode"
    />
  );
}
