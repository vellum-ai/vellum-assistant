/**
 * A chunky, glossy gold credit coin rendered with real CSS 3D depth.
 *
 * SPIKE — research-onboarding flow.
 *
 * Built from a front face, a back face, and a thick stack of edge slices between
 * them — a solid cylinder with genuine thickness when tilted. Rich gradients,
 * specular highlights, a recessed center vignette, and a soft cast shadow give
 * it a shiny, premium look. It's `preserve-3d`, so the caller can spin it.
 */

interface OnboardingCoinProps {
  size: number;
  /** Coin thickness as a fraction of size. */
  depthRatio?: number;
  /** Resting tilt (degrees). */
  tiltX?: number;
  tiltY?: number;
  /** Draw a soft cast shadow beneath the coin. */
  shadow?: boolean;
  className?: string;
}

const EDGE_SLICES = 24;

/** One coin face — raised rim, recessed center, specular shine, embossed $. */
function CoinFace({ idSuffix }: { idSuffix: string }) {
  const face = `cf-${idSuffix}`;
  const rim = `cr-${idSuffix}`;
  const gloss = `cg-${idSuffix}`;
  const vignette = `cv-${idSuffix}`;
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
          <stop offset="45%" stopColor="#EDB323" />
          <stop offset="100%" stopColor="#9C6E0B" />
        </linearGradient>
        <radialGradient id={face} cx="40%" cy="33%" r="78%">
          <stop offset="0%" stopColor="#FFF7D6" />
          <stop offset="40%" stopColor="#F6C637" />
          <stop offset="100%" stopColor="#CE9410" />
        </radialGradient>
        {/* Recess vignette — darkens the face toward the rim. */}
        <radialGradient id={vignette} cx="50%" cy="50%" r="50%">
          <stop offset="62%" stopColor="#000000" stopOpacity="0" />
          <stop offset="100%" stopColor="#7A560A" stopOpacity="0.5" />
        </radialGradient>
        {/* Broad soft gloss. */}
        <radialGradient id={gloss} cx="36%" cy="24%" r="42%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        {/* Tight specular hot-spot. */}
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
        strokeOpacity="0.75"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeDasharray="70 210"
        transform="rotate(-128 50 50)"
      />
      {/* Recessed center face */}
      <circle cx="50" cy="50" r="40" fill={`url(#${face})`} />
      <circle cx="50" cy="50" r="40" fill={`url(#${vignette})`} />
      {/* Groove between rim and face */}
      <circle
        cx="50"
        cy="50"
        r="40"
        fill="none"
        stroke="#8A6308"
        strokeOpacity="0.45"
        strokeWidth="1.6"
      />

      {/* Embossed dollar sign: light edge up-left, dark edge down-right. */}
      <g
        fontFamily="var(--font-sans), system-ui, sans-serif"
        fontWeight={900}
        fontSize="58"
        textAnchor="middle"
        dominantBaseline="central"
      >
        <text x="50" y="52" fill="#7E5906" transform="translate(1.8 2.2)">$</text>
        <text x="50" y="52" fill="#FFF6CF" opacity="0.85" transform="translate(-1.6 -1.8)">$</text>
        <text x="50" y="52" fill="#F1B81F">$</text>
      </g>

      {/* Gloss + hot-spot */}
      <ellipse cx="38" cy="28" rx="22" ry="14" fill={`url(#${gloss})`} />
      <ellipse cx="34" cy="24" rx="7" ry="4.5" fill={`url(#${spec})`} />
    </svg>
  );
}

export function OnboardingCoin({
  size,
  depthRatio = 0.24,
  tiltX = 8,
  tiltY = -22,
  shadow = true,
  className,
}: OnboardingCoinProps) {
  const depth = size * depthRatio;
  const step = depth / (EDGE_SLICES - 1);

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
              "radial-gradient(ellipse at center, rgba(0,0,0,0.32), rgba(0,0,0,0) 70%)",
            filter: "blur(2px)",
          }}
        />
      )}
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
        {/* Edge slices form the coin's thickness; brighter toward the middle of
            the stack so the rim reads as a rounded, specular edge. */}
        {Array.from({ length: EDGE_SLICES }, (_, i) => {
          const t = i / (EDGE_SLICES - 1);
          const mid = 1 - Math.abs(t - 0.5) * 2; // 0 at faces, 1 at middle
          const lightness = 34 + mid * 30;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                background: `linear-gradient(to bottom, hsl(45 92% ${Math.min(lightness + 12, 80)}%), hsl(41 90% ${lightness - 12}%))`,
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
        {/* Back face (rotated so its $ reads correctly facing the viewer) */}
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
    </div>
  );
}
