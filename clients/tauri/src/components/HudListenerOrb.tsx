import { motion } from "framer-motion";
import type { JSX } from "react";
import { useMemo } from "react";

import type { AssistantMode } from "../types.js";

interface HudListenerOrbProps {
  readonly mode: AssistantMode;
  readonly amplitude: number;
  readonly listening: boolean;
  readonly wakeWordActive: boolean;
  readonly onClick?: () => void;
}

const MODE_COLORS: Record<AssistantMode, { core: string; ring: string }> = {
  idle: { core: "#5fdeff", ring: "rgba(95, 222, 255, 0.45)" },
  listening: { core: "#48ffb1", ring: "rgba(72, 255, 177, 0.6)" },
  thinking: { core: "#9c8aff", ring: "rgba(156, 138, 255, 0.55)" },
  speaking: { core: "#ff9f55", ring: "rgba(255, 159, 85, 0.6)" },
  offline: { core: "#ff4d6d", ring: "rgba(255, 77, 109, 0.45)" },
};

/**
 * Arc-reactor centerpiece. Pulses with mic input amplitude and shifts
 * colour based on the assistant's current mode. Click to toggle the mic
 * session manually (push-to-talk style).
 */
export function HudListenerOrb({
  mode,
  amplitude,
  listening,
  wakeWordActive,
  onClick,
}: HudListenerOrbProps): JSX.Element {
  const palette = MODE_COLORS[mode];
  const level = clamp(amplitude, 0, 1);
  const scale = 1 + level * 0.18;
  const ringScale = 1 + level * 0.32;
  const innerLabel = useMemo(() => {
    if (!listening) return "ELI";
    return wakeWordActive ? "WAKE" : "LIVE";
  }, [listening, wakeWordActive]);

  return (
    <button
      type="button"
      className="no-drag relative flex h-44 w-44 items-center justify-center rounded-full"
      onClick={onClick}
      aria-label="Toggle microphone"
    >
      <motion.span
        className="absolute h-44 w-44 rounded-full border"
        style={{ borderColor: palette.ring }}
        animate={{ scale: ringScale, opacity: 0.6 + level * 0.4 }}
        transition={{ type: "spring", stiffness: 260, damping: 30 }}
      />
      <motion.span
        className="absolute h-32 w-32 rounded-full"
        style={{
          background: `radial-gradient(circle at 50% 50%, ${palette.core}33, transparent 70%)`,
        }}
        animate={{ scale: ringScale * 0.95 }}
        transition={{ type: "spring", stiffness: 200, damping: 28 }}
      />
      <motion.span
        className="relative flex h-24 w-24 items-center justify-center rounded-full"
        style={{
          background: `radial-gradient(circle at 50% 30%, ${palette.core}, ${palette.core}55 60%, transparent 100%)`,
          boxShadow: `0 0 24px ${palette.core}aa, 0 0 80px ${palette.core}66`,
        }}
        animate={{ scale }}
        transition={{ type: "spring", stiffness: 280, damping: 24 }}
      >
        <span className="font-display text-[10px] tracking-[0.4em] text-black/80">
          {innerLabel}
        </span>
      </motion.span>
      {!listening ? (
        <span className="absolute -bottom-6 font-display text-[9px] tracking-[0.4em] text-hud-mute">
          TAP TO LISTEN
        </span>
      ) : null}
    </button>
  );
}

function clamp(value: number, lo: number, hi: number): number {
  if (Number.isNaN(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}
