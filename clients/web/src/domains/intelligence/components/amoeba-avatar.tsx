/**
 * The peek tab for the overview's living avatar. On card hover the
 * resting avatar disappears and the hovered card itself floods with the
 * avatar's color (see `SectionCard`'s flood overlay) — this component
 * renders the part that sticks out: a round tab of body on the card edge
 * facing the page center, fully containing the eyes with breathing room,
 * so the flooded card reads as the avatar having poured itself over it.
 *
 * The tab is anchored to the point on the facing edge nearest the page
 * center, springs between cards while hovering moves, and retracts under
 * the card edge when the hover ends. Decorative and pointer-transparent;
 * the geometry helpers are exported so the bento can translate card rects
 * into targets.
 */

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";

import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { pathBBox, unionBBox } from "@/utils/eye-bbox";

/** Which side of the hugged card the eyes peek from (toward page center). */
export type AmoebaFacing = "top" | "bottom" | "left" | "right";

export interface AmoebaRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface AmoebaTarget {
  /** The hovered card's rect, in bento-container coordinates. */
  rect: AmoebaRect;
  facing: AmoebaFacing;
  /** Tab anchor on the facing edge, relative to the rect. */
  peek: { x: number; y: number };
}

/** Keep the tab's center away from the card's corners. */
const PEEK_EDGE_MARGIN = 96;
/** Tab circle diameter — half sticks out past the card edge. */
const TAB_DIAMETER = 150;
/** Eye-pair center distance past the card edge (inside the tab), at full
 *  dome size — scales down with the dome, see {@link domeSizeForCardWidth}. */
const EYE_INSET = 36 * 0.6;
/** How far the tab pulls back under the card edge when retracting. */
const RETRACT_PX = 46;

/** Eye-pair width on the tab at full dome size — one size for every
 *  facing, scales down with the dome. */
const EYE_W = 58 * 0.6;

/** Dome radius of the fused tab shape at full size — 40% smaller than the
 *  old plain circle's radius (`TAB_DIAMETER`/2 = 75). Actually applied at
 *  render time via {@link domeSizeForCardWidth}, which additionally shrinks
 *  it further for any card too narrow to fit it. */
const DOME_R = (TAB_DIAMETER / 2) * 0.6;
/**
 * Half-angle (degrees, from the apex) of the pure circular-arc portion of
 * the dome. Past this angle the outline hands off to the shoulder curve
 * instead of continuing the circle.
 */
const DOME_ARC_HALF_DEG = 50;
/** How far past the dome's edge the shoulder curve reaches before landing
 *  flat, in local (unrotated) x — this is where it merges into the card's
 *  ordinary flat top edge, at full size. */
const SHOULDER_REACH = 55 * 0.6;
/** How far past y=0 (the card's top edge) the shape extends downward, so it
 *  tucks safely behind the real card with no antialiasing seam. */
const SHOULDER_UNDERLAP = 20;

/**
 * A single closed SVG path — "M...Z" — for the fused dome-into-shoulders
 * shape, in local coordinates: apex at (0, -domeR), dome center (i.e. the
 * card edge) at (0, 0), outward = -y. Built from a circular-arc dome
 * (approximated with two mirrored cubic béziers, tangent-matched at both
 * ends so there's no visible kink) plus two more béziers flaring each side
 * out to a flat handoff with the card's ordinary top edge.
 *
 * Tangent-continuous by construction (each bézier's control points align
 * with the previous segment's exit direction), which is what makes the
 * outline read as one fluid blob instead of a circle glued to a box.
 *
 * Parametric in `domeR`/`shoulderReach` (rather than the fixed constants) so
 * the shape itself — not just its position — can be animated: passing 0 for
 * both collapses every point onto the origin, giving a path with the exact
 * same command structure as the full-size one, which is what lets
 * `motion.path` morph smoothly between them instead of just fading/sliding
 * a static shape.
 */
function mergedTabPath(domeR: number, shoulderReach: number): string {
  const rad = (DOME_ARC_HALF_DEG * Math.PI) / 180;
  const archX = domeR * Math.sin(rad);
  const archY = -domeR * Math.cos(rad);
  const tanX = Math.cos(rad);
  const tanY = Math.sin(rad);
  // Bézier-circle-arc approximation constant for this arc's sweep.
  const k = (4 / 3) * Math.tan(rad / 4);
  const domeCp1X = k * domeR;
  const domeCp1Y = -domeR;
  const domeCp2X = archX - tanX * k * domeR;
  const domeCp2Y = archY - tanY * k * domeR;

  const flatX = domeR + shoulderReach;
  // Handle lengths scale with `shoulderReach` (not fixed px) so domeR=0,
  // shoulderReach=0 collapses every control point onto the origin too.
  // CP1 leans further out along the dome's own exit tangent (a longer,
  // more sloped run before it starts curving back), and CP2 sits slightly
  // *past* y=0 (into the card) rather than exactly on it — together these
  // give the curve a genuine S-shaped wave (a shallow concave dip right at
  // the merge) instead of a single flattening arc, reading as a softer,
  // more organic join with the card's flat edge.
  const shoulderCp1X = archX + tanX * shoulderReach * 0.85;
  const shoulderCp1Y = archY + tanY * shoulderReach * 0.85;
  const shoulderCp2X = flatX - shoulderReach * 0.2;
  const shoulderCp2Y = shoulderReach * 0.16;

  const n = (v: number) => Math.round(v * 100) / 100;

  return [
    `M 0,${n(-domeR)}`,
    `C ${n(domeCp1X)},${n(domeCp1Y)} ${n(domeCp2X)},${n(domeCp2Y)} ${n(archX)},${n(archY)}`,
    `C ${n(shoulderCp1X)},${n(shoulderCp1Y)} ${n(shoulderCp2X)},${n(shoulderCp2Y)} ${n(flatX)},0`,
    `L ${n(flatX)},${SHOULDER_UNDERLAP}`,
    `L ${n(-flatX)},${SHOULDER_UNDERLAP}`,
    `C ${n(-shoulderCp2X)},${n(shoulderCp2Y)} ${n(-shoulderCp1X)},${n(shoulderCp1Y)} ${n(-archX)},${n(archY)}`,
    `C ${n(-domeCp2X)},${n(domeCp2Y)} ${n(-domeCp1X)},${n(domeCp1Y)} 0,${n(-domeR)}`,
    "Z",
  ].join(" ");
}

/** Rotation that maps this component's built-in "top" orientation (apex
 *  pointing in -y) onto the actual facing's outward direction. */
function rotationForFacing(out: { x: number; y: number }): number {
  return (Math.atan2(out.y, out.x) * 180) / Math.PI + 90;
}

/**
 * Scales {@link DOME_R}/{@link SHOULDER_REACH} down (uniformly, preserving
 * proportions) just enough that the shape's total width never exceeds the
 * hovered card's own width — the fused shape must never hang over a card's
 * edges, however narrow the card.
 */
function domeSizeForCardWidth(cardWidth: number): {
  domeR: number;
  shoulderReach: number;
} {
  const fullHalfWidth = DOME_R + SHOULDER_REACH;
  const maxHalfWidth = Math.max(16, cardWidth / 2 - 8);
  const scale = Math.min(1, maxHalfWidth / fullHalfWidth);
  return { domeR: DOME_R * scale, shoulderReach: SHOULDER_REACH * scale };
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

/**
 * Tab target for `card`: the anchor point on the `facing` edge nearest
 * the page center (clamped away from the corners).
 */
export function amoebaTargetForCard(
  card: AmoebaRect,
  facing: AmoebaFacing,
  containerCenter: { x: number; y: number },
): AmoebaTarget {
  const alongX = clamp(
    containerCenter.x - card.left,
    PEEK_EDGE_MARGIN,
    card.width - PEEK_EDGE_MARGIN,
  );
  const alongY = clamp(
    containerCenter.y - card.top,
    PEEK_EDGE_MARGIN,
    card.height - PEEK_EDGE_MARGIN,
  );
  const peek =
    facing === "top"
      ? { x: alongX, y: 0 }
      : facing === "bottom"
        ? { x: alongX, y: card.height }
        : facing === "left"
          ? { x: 0, y: alongY }
          : { x: card.width, y: alongY };
  return { rect: card, facing, peek };
}

const OUTWARD: Record<AmoebaFacing, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const TAB_SPRING = {
  type: "spring" as const,
  stiffness: 150,
  damping: 19,
};
/** Delay before the tab pops, so the flood reaches the edge first. */
const TAB_IN_DELAY_S = 0.22;
const TAB_OUT_S = 0.15;

interface AmoebaPeekTabProps {
  hex: string;
  components: CharacterComponents;
  traits: CharacterTraits;
  /** Where to peek from, or `null` when no card is hovered. */
  target: AmoebaTarget | null;
}

export function AmoebaPeekTab({
  hex,
  components,
  traits,
  target,
}: AmoebaPeekTabProps) {
  const active = target !== null;

  // Keep the last geometry while retracting, instead of vanishing in
  // place. Render-time state adjustment (not an effect) so the geometry
  // never lags a frame.
  const [lastTarget, setLastTarget] = useState<AmoebaTarget | null>(null);
  if (target && target !== lastTarget) {
    setLastTarget(target);
  }
  const geo = target ?? lastTarget;

  // Slow random idle blink.
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let t: ReturnType<typeof setTimeout>;
    const idle = () => {
      t = setTimeout(() => {
        if (cancelled) {
          return;
        }
        setBlinking(true);
        t = setTimeout(() => {
          if (cancelled) {
            return;
          }
          setBlinking(false);
          idle();
        }, 140);
      }, 2500 + Math.random() * 4000);
    };
    idle();
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, []);

  const eye = useMemo(() => {
    const def = components.eyeStyles.find((e) => e.id === traits.eyeStyle);
    if (!def) {
      return null;
    }
    return {
      paths: def.paths,
      bbox: unionBBox(def.paths.map((p) => pathBBox(p.svgPath))),
    };
  }, [components, traits.eyeStyle]);

  if (!eye || !geo) {
    return null;
  }

  const { rect, facing, peek } = geo;
  const anchor = { x: rect.left + peek.x, y: rect.top + peek.y };
  const out = OUTWARD[facing];

  // Shrinks further (preserving proportions) for any card narrower than the
  // full-size shape, so the fused avatar never overhangs the card's edges.
  const { domeR, shoulderReach } = domeSizeForCardWidth(rect.width);
  const sizeScale = domeR / DOME_R;

  const aspect = eye.bbox.h / eye.bbox.w;
  const eyeW = EYE_W * sizeScale;
  const eyeH = eyeW * aspect;
  const eyeInset = EYE_INSET * sizeScale;
  const eyeCenter = {
    x: anchor.x + out.x * eyeInset,
    y: anchor.y + out.y * eyeInset,
  };
  const retract = { x: -out.x * RETRACT_PX, y: -out.y * RETRACT_PX };

  const eyeCx = eye.bbox.x + eye.bbox.w / 2;
  const eyeCy = eye.bbox.y + eye.bbox.h / 2;

  const transition = active
    ? {
        ...TAB_SPRING,
        delay: TAB_IN_DELAY_S,
        opacity: { duration: 0.15, delay: TAB_IN_DELAY_S },
      }
    : { duration: TAB_OUT_S };

  const rotateDeg = rotationForFacing(out);
  // Morphs the shape itself (not just its position) between fully collapsed
  // — every point coincident at the origin — and the card-fitted full size,
  // so entering/leaving a card (and moving between differently-sized cards
  // while hovering stays active) reads as fluid growth/shrinkage rather
  // than a static shape merely fading and sliding into place.
  const expandedPathD = mergedTabPath(domeR, shoulderReach);
  const collapsedPathD = mergedTabPath(0, 0);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
      <svg width="100%" height="100%" style={{ overflow: "visible", display: "block" }}>
        <motion.g
          initial={false}
          animate={{
            x: anchor.x + (active ? 0 : retract.x),
            y: anchor.y + (active ? 0 : retract.y),
            rotate: rotateDeg,
            opacity: active ? 1 : 0,
          }}
          style={{ transformOrigin: "0px 0px" }}
          transition={transition}
        >
          <motion.path
            initial={false}
            animate={{ d: active ? expandedPathD : collapsedPathD }}
            transition={transition}
            fill={hex}
          />
        </motion.g>
      </svg>
      <motion.div
        className="absolute top-0 left-0"
        initial={false}
        animate={{
          x: eyeCenter.x - eyeW / 2 + (active ? 0 : retract.x),
          y: eyeCenter.y - eyeH / 2 + (active ? 0 : retract.y),
          width: eyeW,
          height: eyeH,
          opacity: active ? 1 : 0,
        }}
        transition={transition}
      >
        <svg
          viewBox={`${eye.bbox.x} ${eye.bbox.y} ${eye.bbox.w} ${eye.bbox.h}`}
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          style={{ overflow: "visible", display: "block" }}
        >
          <g
            style={{
              transform: blinking ? "scaleY(0.1)" : "scaleY(1)",
              transformOrigin: `${eyeCx}px ${eyeCy}px`,
              transition: "transform 0.14s ease-in-out",
            }}
          >
            {eye.paths.map((p, i) => (
              <path key={i} d={p.svgPath} fill={p.color} />
            ))}
          </g>
        </svg>
      </motion.div>
    </div>
  );
}
