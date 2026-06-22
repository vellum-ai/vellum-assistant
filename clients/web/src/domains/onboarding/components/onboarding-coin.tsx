/**
 * A chunky gold credit coin rendered with real CSS 3D depth (vs. a flat disc).
 *
 * SPIKE — research-onboarding flow.
 *
 * Built from a front face, a back face, and a stack of thin edge slices between
 * them — together they form a solid cylinder, so the coin shows genuine
 * thickness when tilted. The whole thing is tilted by default for a 3D look and
 * is `preserve-3d`, so the caller can spin it (rotateY) and the edge stays
 * visible through the tumble.
 */

interface OnboardingCoinProps {
  size: number;
  /** Coin thickness as a fraction of size. */
  depthRatio?: number;
  /** Resting tilt (degrees). */
  tiltX?: number;
  tiltY?: number;
  className?: string;
}

const EDGE_SLICES = 18;

/** One coin face — a raised rim, a recessed center, and an embossed $. */
function CoinFace({ idSuffix }: { idSuffix: string }) {
  const face = `coinFace-${idSuffix}`;
  const rim = `coinRim-${idSuffix}`;
  const gloss = `coinGloss-${idSuffix}`;
  return (
    <svg
      viewBox="0 0 100 100"
      width="100%"
      height="100%"
      style={{ display: "block", position: "absolute", inset: 0 }}
    >
      <defs>
        <linearGradient id={rim} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0%" stopColor="#FCE38A" />
          <stop offset="50%" stopColor="#E7AE1F" />
          <stop offset="100%" stopColor="#A9790E" />
        </linearGradient>
        <radialGradient id={face} cx="40%" cy="34%" r="72%">
          <stop offset="0%" stopColor="#FFF0B8" />
          <stop offset="55%" stopColor="#F1BE2C" />
          <stop offset="100%" stopColor="#D89E12" />
        </radialGradient>
        <radialGradient id={gloss} cx="38%" cy="26%" r="40%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Raised outer rim */}
      <circle cx="50" cy="50" r="49" fill={`url(#${rim})`} />
      {/* Recessed center face */}
      <circle cx="50" cy="50" r="40" fill={`url(#${face})`} />
      {/* Groove between rim and face */}
      <circle
        cx="50"
        cy="50"
        r="40"
        fill="none"
        stroke="#9A6F0C"
        strokeOpacity="0.4"
        strokeWidth="1.6"
      />

      {/* Embossed dollar sign: light edge up-left, dark edge down-right. */}
      <g
        fontFamily="var(--font-sans), system-ui, sans-serif"
        fontWeight={900}
        fontSize="56"
        textAnchor="middle"
        dominantBaseline="central"
      >
        <text x="50" y="52" fill="#FFF4C6" opacity="0.75" transform="translate(-1.4 -1.6)">$</text>
        <text x="50" y="52" fill="#8A6308" transform="translate(1.4 1.8)">$</text>
        <text x="50" y="52" fill="#EFB31C">$</text>
      </g>

      {/* Top gloss */}
      <ellipse cx="40" cy="29" rx="20" ry="12" fill={`url(#${gloss})`} />
    </svg>
  );
}

export function OnboardingCoin({
  size,
  depthRatio = 0.16,
  tiltX = 8,
  tiltY = -22,
  className,
}: OnboardingCoinProps) {
  const depth = size * depthRatio;
  const step = depth / (EDGE_SLICES - 1);

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        position: "relative",
        transformStyle: "preserve-3d",
        transform: `rotateX(${tiltX}deg) rotateY(${tiltY}deg)`,
      }}
    >
      {/* Edge slices form the coin's solid thickness; lighter toward the middle
          of the stack so the rim reads as a rounded, specular edge. */}
      {Array.from({ length: EDGE_SLICES }, (_, i) => {
        const t = i / (EDGE_SLICES - 1);
        const mid = 1 - Math.abs(t - 0.5) * 2; // 0 at faces, 1 at middle
        const lightness = 36 + mid * 18;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              background: `linear-gradient(to bottom, hsl(44 86% ${lightness + 8}%), hsl(42 88% ${lightness - 10}%))`,
              transform: `translateZ(${-depth / 2 + i * step}px)`,
            }}
          />
        );
      })}

      {/* Front face */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backfaceVisibility: "hidden",
          transform: `translateZ(${depth / 2}px)`,
        }}
      >
        <CoinFace idSuffix="front" />
      </div>
      {/* Back face (rotated so its $ reads correctly when it faces the viewer) */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backfaceVisibility: "hidden",
          transform: `translateZ(${-depth / 2}px) rotateY(180deg)`,
        }}
      >
        <CoinFace idSuffix="back" />
      </div>
    </div>
  );
}
