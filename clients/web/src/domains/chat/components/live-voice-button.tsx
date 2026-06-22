/**
 * `LiveVoiceButton` — composer control that toggles a live-voice conversation.
 *
 * Distinct from the dictation {@link import("./voice-input-button").VoiceInputButton}:
 * that one records a single utterance and drops a transcript into the composer,
 * while this one opens a full-duplex live-voice session via {@link useLiveVoice}
 * (mic streaming + TTS playback + barge-in). The button is gated behind the
 * `voice-mode` assistant flag and renders nothing when the flag is off.
 *
 * Appearance reflects the {@link useLiveVoice} session phase:
 *   - `idle`/`failed`     → mic icon, click to start
 *   - `connecting`        → spinning loader, disabled (token mint / socket open)
 *   - any other (active)  → stop-circle icon, click to stop; the live
 *                           `inputAmplitude` drives a subtle pulse so the user
 *                           sees the mic is hearing them.
 *
 * Wiring into the composer happens in a later PR; this is the standalone control.
 */

import { Loader2, Mic, StopCircle } from "lucide-react";
import { useCallback } from "react";

import { Button } from "@vellumai/design-library";

import { useLiveVoice } from "@/domains/chat/voice/live-voice/use-live-voice";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

interface LiveVoiceButtonProps {
  /** Assistant whose live-voice channel the session attaches to. */
  assistantId: string;
  /** Optional conversation to continue inside the session. */
  conversationId?: string;
  /** Disable the control (e.g. while the composer is otherwise busy). */
  disabled?: boolean;
}

export function LiveVoiceButton({
  assistantId,
  conversationId,
  disabled = false,
}: LiveVoiceButtonProps) {
  const voiceMode = useAssistantFeatureFlagStore.use.voiceMode();
  const { state, inputAmplitude, start, stop } = useLiveVoice();

  const connecting = state === "connecting";
  // Anything past connecting (listening/transcribing/thinking/speaking/ending)
  // means a session is live and the button acts as a stop control.
  const active =
    state !== "idle" && state !== "failed" && state !== "connecting";

  const handleClick = useCallback(() => {
    if (connecting) return;
    if (active) {
      // An active session must always be stoppable, even if the parent has
      // raised `disabled` in the meantime — otherwise the user is stuck with a
      // live mic/socket until some automatic teardown.
      void stop();
    } else {
      // Only the start path honours the external `disabled` prop.
      if (disabled) return;
      void start(assistantId, conversationId);
    }
  }, [active, connecting, disabled, start, stop, assistantId, conversationId]);

  if (!voiceMode) return null;

  const label = connecting
    ? "Connecting live voice"
    : active
      ? "Stop voice mode"
      : "Start voice mode";

  return (
    <Button
      variant="ghost"
      iconOnly={
        connecting ? (
          <Loader2 className="animate-spin" strokeWidth={2} />
        ) : active ? (
          <StopCircle strokeWidth={2} />
        ) : (
          <Mic strokeWidth={2} />
        )
      }
      onClick={handleClick}
      // An active session is always stoppable; the external `disabled` prop
      // only gates the start path. `connecting` stays disabled/busy.
      disabled={connecting || (!active && disabled)}
      aria-label={label}
      aria-pressed={active}
      aria-busy={connecting}
      title={label}
      className="[--vbtn-fg:var(--content-secondary)]"
      style={
        // While listening, scale the icon with live amplitude so the control
        // visibly reacts to the user's voice (clamped to a gentle 1.0–1.25).
        active
          ? { transform: `scale(${1 + Math.min(inputAmplitude, 1) * 0.25})` }
          : undefined
      }
    />
  );
}
