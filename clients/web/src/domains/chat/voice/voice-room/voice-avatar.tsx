import { useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef } from "react";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";

import type { VoiceAvatarVisual } from "./voice-avatar-state";

const DEFAULT_SIZE = 160;

export interface VoiceAvatarProps {
  /** Assistant whose avatar to render; `null` renders the "V" fallback. */
  assistantId: string | null;
  /** Current visual mode, derived from the live-voice session phase. */
  visual: VoiceAvatarVisual;
  /**
   * Amplitude source (0–1), polled inside a rAF loop for the audio-reactive
   * visuals so amplitude never flows through React state/props.
   */
  getAmplitude: () => number;
  /** Rendered avatar diameter in px. */
  size?: number;
}

/**
 * Visuals whose scale rides live amplitude via the rAF loop. Only `responding`
 * (the assistant is speaking): the avatar emits an outward pulse on its own TTS
 * output. `listening` deliberately stays at rest — the user's voice is expressed
 * by the bottom waves coming *in* (see voice-listening-waves.tsx), not by
 * scaling the avatar.
 */
function isAudioReactive(visual: VoiceAvatarVisual): boolean {
  return visual === "responding";
}

/**
 * The large, state-driven assistant avatar at the center of the live-voice
 * room. Resolves the real assistant avatar (character / custom image / "V"
 * fallback) via {@link useAssistantAvatar} and expresses the session phase
 * through a continuous per-visual CSS loop (see `.voice-avatar-*` in
 * index.css).
 *
 * The avatar node stays mounted for the whole session: a visual change only
 * swaps the `voice-avatar--<visual>` class, so the CSS loop cross-fades in
 * place rather than the whole avatar re-popping. The one-time entry spring is
 * owned by the room wrapper (see `voice-room.tsx`), not here.
 *
 * For the audio-reactive visuals a requestAnimationFrame loop polls
 * `getAmplitude()` and writes the `--voice-amp` custom property on the outer
 * `.voice-avatar` node — never through React state, so per-sample updates cause
 * no re-render. It's written on the outer node (not the `__amp` child) so the
 * `::after` emanation ring can read it: only `responding` is reactive, and its
 * TTS-output amplitude drives the color emanating outward (see index.css).
 * Reduced-motion users get the static avatar (CSS loops disabled).
 */
export function VoiceAvatar({
  assistantId,
  visual,
  getAmplitude,
  size = DEFAULT_SIZE,
}: VoiceAvatarProps) {
  const reduce = useReducedMotion();
  const { components, traits, customImageUrl } = useAssistantAvatar(assistantId);

  const ampRef = useRef<HTMLDivElement | null>(null);
  // Keep the latest amplitude source without re-initializing the rAF loop.
  const getAmplitudeRef = useRef(getAmplitude);
  useLayoutEffect(() => {
    getAmplitudeRef.current = getAmplitude;
  }, [getAmplitude]);

  const audioReactive = isAudioReactive(visual);

  useEffect(() => {
    const node = ampRef.current;
    if (!node) {
      return;
    }
    // Non-reactive visuals (or reduced motion) sit at rest.
    if (reduce || !audioReactive) {
      node.style.setProperty("--voice-amp", "0");
      return;
    }

    let rafId = 0;
    let lastWritten = "";
    const tick = () => {
      const amp = Math.min(1, Math.max(0, getAmplitudeRef.current()));
      const next = amp.toFixed(3);
      // Skip the style write (and its recalc) when the rounded value is
      // unchanged — amplitude often holds flat between frames.
      if (next !== lastWritten) {
        lastWritten = next;
        node.style.setProperty("--voice-amp", next);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      node.style.setProperty("--voice-amp", "0");
    };
    // Re-runs on any visual change to start/stop the loop at the audio-reactive
    // boundary; the avatar node itself is stable, so this only (re)attaches the
    // rAF, it never remounts the avatar.
  }, [visual, audioReactive, reduce]);

  return (
    <div
      ref={ampRef}
      className={`voice-avatar voice-avatar--${visual}`}
      style={{ width: size, height: size }}
    >
      <div className="voice-avatar__amp">
        <ChatAvatar
          components={components}
          traits={traits}
          customImageUrl={customImageUrl}
          size={size}
        />
      </div>
    </div>
  );
}
