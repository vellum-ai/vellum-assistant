/**
 * Ambient backdrop for the live-voice room: a deep-dark radial-gradient void
 * (near-black center fading to pure black at the edges) with a scatter of
 * slow-drifting indigo particles floating over it.
 *
 * Purely decorative — it sits behind the avatar and carries no interaction. The
 * void gradient and particle glows are fixed rgba (a deliberate constant accent,
 * like a data-viz series or annotation overlay — see STYLE_GUIDE color rules),
 * not theme tokens: the room is always its own dark space regardless of app
 * theme. The drift animation lives in `index.css` (`.voice-room-particle`) and
 * is frozen under `prefers-reduced-motion`.
 */

import { useReducedMotion } from "motion/react";
import { type CSSProperties } from "react";

/**
 * Deterministic particle layout — position (%), diameter (px), animation
 * duration (s) and delay (s), and drift vector (px). Fixed rather than random
 * so the field is stable across renders and reads as intentional.
 */
interface Particle {
  left: number;
  top: number;
  size: number;
  duration: number;
  delay: number;
  driftX: number;
  driftY: number;
  opacity: number;
}

const PARTICLES: Particle[] = [
  { left: 12, top: 68, size: 5, duration: 15, delay: 0, driftX: 24, driftY: -60, opacity: 0.5 },
  { left: 22, top: 28, size: 3, duration: 19, delay: 3, driftX: -18, driftY: -48, opacity: 0.4 },
  { left: 34, top: 82, size: 6, duration: 17, delay: 1.5, driftX: 30, driftY: -70, opacity: 0.55 },
  { left: 46, top: 18, size: 4, duration: 21, delay: 5, driftX: -12, driftY: -40, opacity: 0.35 },
  { left: 58, top: 74, size: 5, duration: 16, delay: 2, driftX: -28, driftY: -66, opacity: 0.5 },
  { left: 68, top: 34, size: 3, duration: 20, delay: 4, driftX: 20, driftY: -52, opacity: 0.4 },
  { left: 78, top: 62, size: 6, duration: 18, delay: 0.8, driftX: -24, driftY: -74, opacity: 0.55 },
  { left: 88, top: 24, size: 4, duration: 22, delay: 6, driftX: 14, driftY: -44, opacity: 0.35 },
  { left: 8, top: 44, size: 3, duration: 23, delay: 2.6, driftX: 22, driftY: -56, opacity: 0.4 },
  { left: 52, top: 52, size: 4, duration: 14, delay: 3.4, driftX: 16, driftY: -62, opacity: 0.45 },
];

export function VoiceRoomAmbientBackground() {
  const reduce = useReducedMotion();

  return (
    <div className="voice-room-void" aria-hidden>
      {PARTICLES.map((p, i) => (
        <span
          key={i}
          className="voice-room-particle"
          style={{
            left: `${p.left}%`,
            top: `${p.top}%`,
            width: p.size,
            height: p.size,
            // Reduced motion: the CSS media query already freezes the
            // animation; also drop it here so the inline vars never drive a
            // transform. The static particles sit at a low opacity.
            "--particle-opacity": p.opacity,
            "--drift-x": `${p.driftX}px`,
            "--drift-y": `${p.driftY}px`,
            "--drift-duration": `${p.duration}s`,
            animationDelay: reduce ? undefined : `${p.delay}s`,
            opacity: reduce ? 0.25 : undefined,
          } as CSSProperties}
        />
      ))}
    </div>
  );
}
