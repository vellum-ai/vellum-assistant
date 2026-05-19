import { motion } from "framer-motion";
import type { JSX } from "react";
import { useMemo } from "react";

import type { AssistantMode } from "../types.js";

interface HudListenerOrbProps {
  readonly mode: AssistantMode;
  readonly amplitude: number;
  readonly listening: boolean;
  readonly conversationActive: boolean;
  readonly wakeWordActive: boolean;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}

const MODE_COLORS: Record<AssistantMode, { core: string; ring: string }> = {
  idle: { core: "#5fdeff", ring: "rgba(95, 222, 255, 0.45)" },
  listening: { core: "#48ffb1", ring: "rgba(72, 255, 177, 0.6)" },
  thinking: { core: "#9c8aff", ring: "rgba(156, 138, 255, 0.55)" },
  speaking: { core: "#ff9f55", ring: "rgba(255, 159, 85, 0.6)" },
  offline: { core: "#ff4d6d", ring: "rgba(255, 77, 109, 0.45)" },
};

const ARC_TAGS = [
  "RX",
  "TX",
  "MEM",
  "CPU",
  "ENC",
  "VEC",
  "AUX",
  "DSP",
  "SYS",
  "VAD",
  "STT",
  "TTS",
] as const;

/**
 * Cinematic arc-reactor centerpiece. Renders a multi-ring HUD orb with:
 *   - mic-amplitude driven core pulse
 *   - rotating outer label arc (RX/TX/MEM/CPU/...)
 *   - tick gauge, callout ring, conic sweep
 *   - radial waveform driven by amplitude
 *   - drifting particles for ambient life
 *
 * Click toggles the mic session manually (push-to-talk style).
 */
export function HudListenerOrb({
  mode,
  amplitude,
  listening,
  conversationActive,
  wakeWordActive,
  disabled = false,
  onClick,
}: HudListenerOrbProps): JSX.Element {
  const palette = MODE_COLORS[mode];
  const level = clamp(amplitude, 0, 1);
  const scale = 1 + level * 0.2;
  const ringScale = 1 + level * 0.34;
  const waveform = Array.from({ length: 36 }, (_, index) => {
    const phase = (index % 9) / 9;
    return 16 + Math.round((Math.sin(phase * Math.PI) * 16 + level * 44) * 10) / 10;
  });

  const particles = useMemo(
    () =>
      Array.from({ length: 18 }, (_, i) => {
        const angle = (i / 18) * Math.PI * 2;
        const r = 32 + (i % 5) * 4;
        return {
          left: 50 + Math.cos(angle) * r,
          top: 50 + Math.sin(angle) * r,
          dx: Math.cos(angle * 2) * 8,
          dy: Math.sin(angle * 2) * 8,
          delay: (i * 137) % 4000,
        };
      }),
    [],
  );

  const innerLabel = useMemo(() => {
    if (listening) return "LIVE";
    if (conversationActive) return "CHAT";
    return wakeWordActive ? "ARMED" : "ELI";
  }, [conversationActive, listening, wakeWordActive]);

  return (
    <button
      type="button"
      className="no-drag relative flex h-full w-full items-center justify-center rounded-full"
      onClick={onClick}
      disabled={disabled}
      aria-label="Toggle microphone"
      title={disabled ? "Assistant connection is offline" : "Toggle microphone"}
    >
      <div className="reactor-callout-ring" />
      <div className="reactor-outer-ring" />
      <div className="reactor-tick" />
      <div className="reactor-mid-ring" />
      <div className="reactor-inner-ring" />
      <div className="reactor-sweep" />

      {/* Rotating outer arc of system labels — like a circular ticker. */}
      <div
        className="absolute inset-0 origin-center"
        style={{ animation: "reactor-spin 38s linear infinite" }}
      >
        {ARC_TAGS.map((tag, i) => {
          const angle = (i / ARC_TAGS.length) * 360;
          return (
            <span
              key={tag}
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 font-display text-[8px] tracking-[0.42em] text-hud-accent/55"
              style={{
                transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-46%) rotate(${-angle}deg)`,
              }}
            >
              {tag}
            </span>
          );
        })}
      </div>

      {/* Cardinal pip markers around the outer ring. */}
      {[0, 90, 180, 270].map((deg) => (
        <span
          key={deg}
          className="reactor-pip"
          style={{
            left: "50%",
            top: "50%",
            transform: `translate(-50%, -50%) rotate(${deg}deg) translateY(-44%)`,
          }}
        />
      ))}

      <span className="reactor-node node-top">SYS · 7821</span>
      <span className="reactor-node node-right">RX · {Math.round(level * 99)}</span>
      <span className="reactor-node node-bottom">AUX · {mode.toUpperCase()}</span>
      <span className="reactor-node node-left">TX · OK</span>

      <div className="absolute inset-[22%] rounded-full border border-hud-accent/20" />

      {/* Radial waveform inside inner ring. */}
      <div className="absolute inset-[26%] grid place-items-center rounded-full">
        {waveform.map((height, index) => (
          <span
            key={index}
            className="absolute left-1/2 top-1/2 w-[2px] origin-[50%_86px] rounded-full bg-hud-accent/70 shadow-[0_0_10px_rgba(95,222,255,0.65)]"
            style={{
              height: `${height}px`,
              transform: `translate(-50%, -86px) rotate(${index * 10}deg)`,
            }}
          />
        ))}
      </div>

      {/* Ambient particle layer (between mid and inner rings). */}
      {particles.map((p, i) => (
        <span
          key={i}
          className="particle"
          style={
            {
              left: `${p.left}%`,
              top: `${p.top}%`,
              animationDelay: `${p.delay}ms`,
              ["--dx" as never]: `${p.dx}px`,
              ["--dy" as never]: `${p.dy}px`,
            } as React.CSSProperties
          }
        />
      ))}

      <motion.span
        className="absolute h-[44%] w-[44%] rounded-full border"
        style={{ borderColor: palette.ring }}
        animate={{ scale: ringScale, opacity: 0.6 + level * 0.4 }}
        transition={{ type: "spring", stiffness: 260, damping: 30 }}
      />
      <motion.span
        className="absolute h-[32%] w-[32%] rounded-full"
        style={{
          background: `radial-gradient(circle at 50% 50%, ${palette.core}33, transparent 70%)`,
        }}
        animate={{ scale: ringScale * 0.95 }}
        transition={{ type: "spring", stiffness: 200, damping: 28 }}
      />
      <motion.span
        className="relative flex h-[24%] w-[24%] items-center justify-center rounded-full border border-white/20"
        style={{
          background: `radial-gradient(circle at 50% 30%, ${palette.core}, ${palette.core}55 60%, transparent 100%)`,
          boxShadow: `0 0 24px ${palette.core}aa, 0 0 80px ${palette.core}66`,
        }}
        animate={{ scale }}
        transition={{ type: "spring", stiffness: 280, damping: 24 }}
      >
        <span className="font-display flex flex-col items-center text-black/80">
          <span className="text-[10px] tracking-[0.38em]">{innerLabel}</span>
          <span className="mt-1 text-[18px] tracking-normal">
            {Math.round(level * 99).toString().padStart(2, "0")}
          </span>
        </span>
      </motion.span>
      {!listening ? (
        <span className="absolute bottom-[18%] font-display text-[9px] tracking-[0.4em] text-hud-mute">
          {disabled ? "WAITING FOR LINK" : "TAP TO LISTEN"}
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
