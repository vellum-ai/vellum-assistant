/**
 * Voice-session composer bar (Light 53): while a live-voice session is
 * active the composer's action row is replaced by this bar — a small mic
 * glyph and muted state label on the left, the dotted timeline waveform
 * filling the middle, and end (✕) / send-now (↑) controls on the right.
 *
 * Purely presentational: the parent owns the `useLiveVoice` session and
 * wires `state`, an amplitude poll function, and the two callbacks. The
 * green ↑ is a manual "send now" (push-to-talk release) and is only
 * meaningful while the session is listening; the red ✕ ends the session
 * and is always available.
 *
 * Layout mirrors the composer's bottom action row (`px-2 pb-2`, regular
 * `h-8` icon buttons) so swapping the rows in during a session causes no
 * layout shift.
 */

import { ArrowUp, Mic, X } from "lucide-react";

import { Button } from "@vellumai/design-library";

import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";
import { VoiceTimelineWaveform } from "@/domains/chat/voice/voice-timeline-waveform";

/**
 * Deliberately minimal state treatment (decided 2026-07-06): assistant
 * output streams into the thread transcript like text chat, so the bar
 * only carries a small label. `idle`/`failed` map to an empty label —
 * the parent unmounts the bar in those states.
 *
 * Exported for the title-bar session pill (`voice-session-pill-host.tsx`),
 * which shows the same activity label while the user is away from the
 * owning thread.
 */
export const STATE_LABELS: Record<LiveVoiceSessionState, string> = {
  idle: "",
  connecting: "Connecting…",
  listening: "Listening…",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  ending: "Ending…",
  failed: "",
};

export interface VoiceComposerBarProps {
  state: LiveVoiceSessionState;
  /** Polled ~30 Hz by the waveform's draw loop — no re-render per sample. */
  getAmplitude: () => number;
  /** Red ✕ — end the voice session. */
  onEnd: () => void;
  /** Green ↑ — manually release the current turn (send now). */
  onSend: () => void;
}

export function VoiceComposerBar({
  state,
  getAmplitude,
  onEnd,
  onSend,
}: VoiceComposerBarProps) {
  return (
    <div
      role="group"
      aria-label="Voice session"
      className="flex items-center gap-3 px-2 pb-2"
    >
      {/* pl-2 lines the mic up with the textarea's px-4 text inset. */}
      <div className="flex shrink-0 items-center gap-2 pl-2">
        <Mic
          aria-hidden
          className="h-4 w-4 text-[var(--content-secondary)]"
        />
        {/* Muted placeholder styling — matches the textarea's placeholder. */}
        <span
          aria-live="polite"
          className="text-chat text-[var(--content-disabled)]"
        >
          {STATE_LABELS[state]}
        </span>
      </div>
      <VoiceTimelineWaveform
        getAmplitude={getAmplitude}
        active={state === "listening"}
        className="min-w-0 flex-1"
      />
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="danger"
          iconOnly={<X className="h-4 w-4" strokeWidth={2.5} />}
          onClick={onEnd}
          aria-label="End voice session"
        />
        <Button
          variant="primary"
          iconOnly={<ArrowUp className="h-4 w-4" strokeWidth={2.5} />}
          onClick={onSend}
          disabled={state !== "listening"}
          aria-label="Send now"
        />
      </div>
    </div>
  );
}
