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
/** Eye-pair center distance past the card edge (inside the tab). */
const EYE_INSET = 36;
/** How far the tab pulls back under the card edge when retracting. */
const RETRACT_PX = 46;

/** Eye-pair width on the tab — one size for every facing. */
const EYE_W = 58;

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

  const aspect = eye.bbox.h / eye.bbox.w;
  const eyeW = EYE_W;
  const eyeH = eyeW * aspect;
  const eyeCenter = {
    x: anchor.x + out.x * EYE_INSET,
    y: anchor.y + out.y * EYE_INSET,
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

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
      <motion.div
        className="absolute top-0 left-0 rounded-full"
        style={{
          backgroundColor: hex,
          width: TAB_DIAMETER,
          height: TAB_DIAMETER,
        }}
        initial={false}
        animate={{
          x: anchor.x - TAB_DIAMETER / 2 + (active ? 0 : retract.x),
          y: anchor.y - TAB_DIAMETER / 2 + (active ? 0 : retract.y),
          opacity: active ? 1 : 0,
        }}
        transition={transition}
      />
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
