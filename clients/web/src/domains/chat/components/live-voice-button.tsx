/**
 * `LiveVoiceButton` — composer entry point for a live-voice conversation.
 *
 * Distinct from the dictation {@link import("./voice-input-button").VoiceInputButton}:
 * that one records a single utterance and drops a transcript into the composer,
 * while this one starts a full-duplex live-voice session (mic streaming + TTS
 * playback + barge-in). The button is gated behind the `voice-mode` assistant
 * flag and renders nothing when the flag is off.
 *
 * Purely presentational: the `useLiveVoice` controller lives in the
 * layout-mounted `useLiveVoiceSessionController`; the composer binds the
 * assistant/conversation into `onStart`, which drives the store-registered
 * session starter. While a session is active the owning composer swaps its
 * whole action row — this button included — for the `VoiceComposerBar`, whose
 * ✕ owns ending the session; in non-owning composers the button stays visible
 * but disabled, so this control never needs a stop affordance.
 */

import { Mic } from "lucide-react";

import { Button } from "@vellumai/design-library";

import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

interface LiveVoiceButtonProps {
  /** Start a live-voice session (the composer binds assistant + conversation). */
  onStart: () => void;
  /** Disable the control (e.g. while dictation is recording). */
  disabled?: boolean;
}

export function LiveVoiceButton({
  onStart,
  disabled = false,
}: LiveVoiceButtonProps) {
  const voiceMode = useAssistantFeatureFlagStore.use.voiceMode();

  if (!voiceMode) return null;

  return (
    <Button
      variant="ghost"
      iconOnly={<Mic strokeWidth={2} />}
      onClick={onStart}
      disabled={disabled}
      aria-label="Start voice mode"
      title="Start voice mode"
      className="[--vbtn-fg:var(--content-secondary)]"
    />
  );
}
