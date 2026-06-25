/**
 * A flat, glossy gold credit coin (no thickness), facing forward.
 *
 * SPIKE — research-onboarding flow.
 *
 * A front + back face back-to-back, kept in a `preserve-3d` context only so the
 * coin can still flip on claim. Pass `spinning` to make it tumble; the caller
 * can wrap it in a plain 2D motion element for a flight path.
 */

import { motion } from "motion/react";

interface OnboardingCoinProps {
  size: number;
  /** Resting tilt (degrees) — face-forward by default. */
  tiltX?: number;
  tiltY?: number;
  /** Draw a soft cast shadow beneath the coin. */
  shadow?: boolean;
  /** Tumble through a few full turns (e.g. while claiming). */
  spinning?: boolean;
  className?: string;
}

/** One coin face — raised rim, even gold center, specular shine, embossed $. */
function CoinFace({ idSuffix }: { idSuffix: string }) {
  const face = `cf-${idSuffix}`;
  const rim = `cr-${idSuffix}`;
  const gloss = `cg-${idSuffix}`;
  const spec = `cs-${idSuffix}`;
  return (
    <svg
      viewBox="0 0 100 100"
      width="100%"
      height="100%"
      style={{ display: "block", position: "absolute", inset: 0 }}
    >
      <defs>
        <linearGradient id={rim} x1="0.12" y1="0.05" x2="0.85" y2="0.95">
          <stop offset="0%" stopColor="#FFF0AE" />
          <stop offset="50%" stopColor="#F4C231" />
          <stop offset="100%" stopColor="#D29B1A" />
        </linearGradient>
        <radialGradient id={face} cx="42%" cy="36%" r="82%">
          <stop offset="0%" stopColor="#FFF6CE" />
          <stop offset="55%" stopColor="#F8CB3E" />
          <stop offset="100%" stopColor="#EEB52C" />
        </radialGradient>
        <radialGradient id={gloss} cx="36%" cy="24%" r="44%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={spec} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="1" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Raised outer rim */}
      <circle cx="50" cy="50" r="49" fill={`url(#${rim})`} />
      {/* Bright specular arc along the top-left of the rim */}
      <circle
        cx="50"
        cy="50"
        r="45.5"
        fill="none"
        stroke="#FFF6CF"
        strokeOpacity="0.6"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeDasharray="70 210"
        transform="rotate(-128 50 50)"
      />
      {/* Center face */}
      <circle cx="50" cy="50" r="40" fill={`url(#${face})`} />
      {/* Subtle groove between rim and face */}
      <circle
        cx="50"
        cy="50"
        r="40"
        fill="none"
        stroke="#C28F18"
        strokeOpacity="0.35"
        strokeWidth="1.4"
      />

      {/* Embossed dollar sign — soft emboss, bright gold. `textAnchor=middle`
          centers horizontally and `dy=0.355em` (~half the cap height) centers
          vertically across browsers; `dominantBaseline` is avoided because iOS
          WebKit renders it unreliably. */}
      <g
        fontFamily="var(--font-sans), system-ui, sans-serif"
        fontWeight={900}
        fontSize="58"
        textAnchor="middle"
      >
        <text x="50" y="50" dy="0.355em" fill="#C88E16" transform="translate(1.3 1.6)">$</text>
        <text x="50" y="50" dy="0.355em" fill="#FFF6CF" opacity="0.7" transform="translate(-1.3 -1.5)">$</text>
        <text x="50" y="50" dy="0.355em" fill="#F4C12A">$</text>
      </g>

      {/* Gloss + hot-spot */}
      <ellipse cx="38" cy="28" rx="22" ry="14" fill={`url(#${gloss})`} />
      <ellipse cx="34" cy="24" rx="7" ry="4.5" fill={`url(#${spec})`} />
    </svg>
  );
}

export function OnboardingCoin({
  size,
  tiltX = 0,
  tiltY = 0,
  shadow = true,
  spinning = false,
  className,
}: OnboardingCoinProps) {
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      {/* Soft cast shadow beneath the coin. */}
      {shadow && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: "50%",
            bottom: -size * 0.14,
            width: size * 0.74,
            height: size * 0.16,
            transform: "translateX(-50%)",
            background:
              "radial-gradient(ellipse at center, rgba(0,0,0,0.22), rgba(0,0,0,0) 70%)",
            filter: "blur(2px)",
          }}
        />
      )}
      {/* Perspective only so the coin can flip on claim; it sits flat otherwise. */}
      <div style={{ width: size, height: size, perspective: size * 10 }}>
        <motion.div
          className={className}
          style={{
            width: size,
            height: size,
            position: "relative",
            transformStyle: "preserve-3d",
          }}
          initial={false}
          animate={{
            rotateX: tiltX,
            rotateY: spinning
              ? [tiltY, tiltY + 360, tiltY + 760, tiltY + 1180]
              : tiltY,
          }}
          transition={
            spinning
              ? { duration: 0.95, times: [0, 0.32, 0.62, 1], ease: "easeInOut" }
              : { duration: 0 }
          }
        >
          {/* Front + back faces, back-to-back (a hair apart to avoid z-fighting)
              so the coin can still flip on claim. */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              backfaceVisibility: "hidden",
              transform: "translateZ(0.5px)",
            }}
          >
            <CoinFace idSuffix="front" />
          </div>
          <div
            style={{
              position: "absolute",
              inset: 0,
              backfaceVisibility: "hidden",
              transform: "translateZ(-0.5px) rotateY(180deg)",
            }}
          >
            <CoinFace idSuffix="back" />
          </div>
        </motion.div>
      </div>
    </div>
  );
}
