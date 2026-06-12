/**
 * `LiveVoiceButton` — composer control that toggles voice mode.
 *
 * Distinct from the dictation {@link import("./voice-input-button").VoiceInputButton}:
 * that one records a single utterance and drops a transcript into the composer,
 * while this one runs the voice-mode conversation loop via {@link useVoiceMode}
 * (mic streaming + TTS playback + barge-in + auto-listen between turns). The
 * button is gated behind the `voice-mode` assistant flag and renders nothing
 * when the flag is off.
 *
 * Appearance / click behavior follow the mode state:
 *   - `off`          → mic icon, click activates the mode (idle → listening)
 *   - `speaking`     → mic icon, click interrupts the response and listens
 *                      again (the LUM-1969 "mic button mid-playback" path)
 *   - any other      → stop-circle icon, click turns the mode off; while
 *                      listening the live `inputAmplitude` drives a subtle
 *                      pulse so the user sees the mic is hearing them.
 *
 * The session-level `connecting` phase (sub-second token mint / socket open)
 * shows a spinner so a click can't race the handshake.
 */

import { Loader2, Mic, StopCircle } from "lucide-react";
import { useCallback } from "react";

import { Button } from "@vellumai/design-library";

import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { useVoiceMode } from "@/domains/chat/voice/live-voice/use-voice-mode";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

interface LiveVoiceButtonProps {
  /** Assistant whose live-voice channel the conversation attaches to. */
  assistantId: string;
  /** Optional conversation to continue inside the voice conversation. */
  conversationId?: string;
  /** Disable the control (e.g. while the composer is otherwise busy). */
  disabled?: boolean;
}

export function LiveVoiceButton({
  assistantId,
  conversationId,
  disabled = false,
}: LiveVoiceButtonProps) {
  const voiceModeFlag = useAssistantFeatureFlagStore.use.voiceMode();
  const { state, inputAmplitude, activate, deactivate, interrupt } =
    useVoiceMode({ assistantId, conversationId });

  // The session-level connecting phase is the only window where a click has
  // nothing meaningful to do (the mode is on but the socket isn't up yet).
  const sessionState = useLiveVoiceStore.use.state();
  const connecting = state !== "off" && sessionState === "connecting";

  const active = state !== "off";
  const speaking = state === "speaking";

  const handleClick = useCallback(() => {
    if (connecting) return;
    if (speaking) {
      // Mid-playback the mic button is the interrupt: playback stops and the
      // mode goes straight back to listening.
      interrupt();
      return;
    }
    if (active) {
      // An active mode must always be stoppable, even if the parent has
      // raised `disabled` in the meantime — otherwise the user is stuck with
      // a live mic until some automatic teardown.
      void deactivate();
      return;
    }
    // Only the start path honours the external `disabled` prop.
    if (disabled) return;
    void activate();
  }, [active, connecting, deactivate, disabled, interrupt, activate, speaking]);

  if (!voiceModeFlag) return null;

  const label = connecting
    ? "Connecting voice mode"
    : speaking
      ? "Interrupt and speak"
      : active
        ? "Stop voice mode"
        : "Start voice mode";

  return (
    <Button
      variant="ghost"
      iconOnly={
        connecting ? (
          <Loader2 className="animate-spin" strokeWidth={2} />
        ) : active && !speaking ? (
          <StopCircle strokeWidth={2} />
        ) : (
          <Mic strokeWidth={2} />
        )
      }
      onClick={handleClick}
      // An active mode is always stoppable; the external `disabled` prop
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
