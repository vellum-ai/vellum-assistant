/**
 * The sidebar's assistant cluster: the "Your Assistant" nav row dressed up
 * as the assistant — a standard-height row painted solid in the avatar's
 * color, name left-aligned, the avatar's eyes resting grown on the right,
 * sunk a touch through the row's bottom edge — with the "New Chat"
 * row directly beneath it.
 *
 * Periodically — and immediately on hovering the New Chat row —
 * the assistant goes visiting: the eyes grow a touch, duck under their
 * row's bottom fold, and resurface inside the New Chat row below
 * while the avatar color floods that row like water (a clip-path circle
 * expanding from where the eyes surface, echoing the overview cards'
 * flood — see `identity-overview.tsx`). While they're away the assistant
 * row drains to a plain nav item — the color has moved rows, not been
 * copied. After a beat (or once the pointer leaves) they duck back under
 * and pop up at their perch as the flood recedes and the color returns.
 * The eyes never shrink below their grown size and never wander left of
 * the name.
 *
 * The assistant name is never bolded and always renders white on the
 * avatar-colored row — except on light avatar colors (yellow), where it
 * flips dark for contrast. While drained (eyes visiting) it reads as a
 * regular nav item's text.
 *
 * Falls back to plain `SideMenu.Item`s when there's no character avatar to
 * dress as (custom image / not loaded).
 */

import { Brain, SquarePen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";

import { cn, SideMenu } from "@vellumai/design-library";

import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { contrastForeground } from "@/utils/avatar-tone";
import { pathBBox, unionBBox } from "@/utils/eye-bbox";

/** Standard nav-row height, matching `SideMenu.Item`. */
const ROW_HEIGHT = 30;
/** Mobile-overlay row height, matching `SideMenu.Item`'s mobile row. */
const MOBILE_ROW_HEIGHT = 44;
/**
 * Hand-tuned base (unscaled) sprite width per eye style — the catalog is a
 * handful of shapes whose aspect ratios vary too wildly (gentle ≈ 1.1 wide
 * per tall, grumpy ≈ 4.6) for one derived formula to size them all well.
 * Height follows each style's own aspect ratio at its width; the resting
 * eyes render at {@link REST_SCALE} times these. Styles missing from the
 * map (a future catalog addition) fall back to {@link DEFAULT_EYES_WIDTH}.
 */
const EYE_STYLE_WIDTHS: Record<string, number> = {
  grumpy: 22,
  angry: 14,
  curious: 14,
  goofy: 12,
  surprised: 15,
  bashful: 15,
  gentle: 11,
  quirky: 12,
  dazed: 16,
};
const DEFAULT_EYES_WIDTH = 14;
/** Reference height for scaling the bottom-edge sink: shapes about this
 *  tall sink the full {@link EDGE_SINK}; flatter ones sink less. */
const SINK_REFERENCE_HEIGHT = 10;
const ROW_PADDING_X = 6;
/** The eyes' permanent grown size at their perch. */
const REST_SCALE = 2.1;
/** The extra growth spurt right before ducking under a row's bottom fold. */
const DUCK_SCALE = 2.6;
/** Distance from a row's right edge to the eye slot (pre-scale). */
const EYES_RIGHT_OFFSET = 18;
/** How far the resting eyes sink through their row's bottom edge. */
const EDGE_SINK = 4;
/** Flood origin: where the eyes surface, as a percent of the row's width. */
const FLOOD_ORIGIN_X_PERCENT = 88;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const jitter = (base: number, spread: number): number =>
  base + Math.random() * spread;

type EyesControls = ReturnType<typeof useAnimationControls>;

interface EyeArt {
  id: string;
  paths: { svgPath: string; color: string }[];
  bbox: { x: number; y: number; w: number; h: number };
}

interface AssistantNavItemProps {
  assistantId: string | null;
  label: string;
  active: boolean;
  collapsed?: boolean;
  onSelect?: () => void;
  /** Renders the "New Chat" row under the assistant row. */
  onNewConversation?: () => void;
}

export function AssistantNavItem({
  assistantId,
  label,
  active,
  collapsed = false,
  onSelect,
  onNewConversation,
}: AssistantNavItemProps) {
  const { components, traits } = useAssistantAvatar(assistantId);
  const reduce = useReducedMotion();
  const isMobile = useIsMobile();
  const pillEyes = useAnimationControls();
  const newConvEyes = useAnimationControls();
  const [blinking, setBlinking] = useState(false);
  /** True while the eyes are down in the New Chat row (drives the
   *  flood overlay + that row's contrast-tone content, and drains the
   *  assistant row back to a plain nav item). */
  const [visiting, setVisiting] = useState(false);
  /** Live pointer-over state for the New Chat row; the animation
   *  loop polls it to summon the eyes on hover. */
  const hoverRef = useRef(false);

  const rowHeight = isMobile ? MOBILE_ROW_HEIGHT : ROW_HEIGHT;

  const eye = useMemo<EyeArt | null>(() => {
    if (!components || !traits) {
      return null;
    }
    const def = components.eyeStyles.find((e) => e.id === traits.eyeStyle);
    if (!def) {
      return null;
    }
    return {
      id: def.id,
      paths: def.paths,
      bbox: unionBBox(def.paths.map((p) => pathBBox(p.svgPath))),
    };
  }, [components, traits]);

  /** Per-style hand-tuned width; height follows the shape's aspect ratio. */
  const eyesWidth = eye
    ? (EYE_STYLE_WIDTHS[eye.id] ?? DEFAULT_EYES_WIDTH)
    : 0;
  const eyesHeight = eye ? eyesWidth * (eye.bbox.h / eye.bbox.w) : 0;
  /** Bottom-edge sink scales with the shape's height so flatter variants
   *  keep the same visible fraction above the fold. */
  const edgeSink =
    EDGE_SINK * Math.min(1, eyesHeight / SINK_REFERENCE_HEIGHT);
  /** Top of the (unscaled) eye slot, vertically centered in a row. */
  const slotTop = (rowHeight - eyesHeight) / 2;
  /** Resting offset: bottom edge of the row plus a small sink, so the grown
   *  eyes render cut off by the edge. (`slotTop` is also exactly the offset
   *  that puts the sprite's bottom flush with the row's bottom.) */
  const restY = slotTop + edgeSink;
  /** Fully below a row even at {@link DUCK_SCALE} (scale grows upward from
   *  the bottom-center origin). */
  const diveY = rowHeight + 20;

  const showNewConversation = Boolean(onNewConversation) && !collapsed;

  useEffect(() => {
    if (reduce) {
      return;
    }
    let cancelled = false;
    const blink = async () => {
      if (cancelled) {
        return;
      }
      setBlinking(true);
      await sleep(140);
      setBlinking(false);
      await sleep(160);
    };
    const move = (
      controls: EyesControls,
      to: { x?: number; y?: number; scale?: number },
      transition: Record<string, unknown>,
    ) =>
      cancelled
        ? Promise.resolve()
        : controls.start({ ...to, transition }).catch(() => {});
    const spring = (stiffness: number, damping: number) => ({
      type: "spring",
      stiffness,
      damping,
    });
    const duckUnder = async (controls: EyesControls) => {
      await move(controls, { scale: DUCK_SCALE }, spring(300, 15));
      await move(controls, { y: diveY }, { duration: 0.3, ease: "easeIn" });
    };
    const surfaceAt = (
      controls: EyesControls,
      springiness: [number, number],
    ) => {
      controls.set({ x: 0, y: diveY, scale: REST_SCALE });
      return move(controls, { y: restY }, spring(...springiness));
    };

    // One leg of the visit each: duck under the assistant row's fold and
    // surface in the New Chat row (the flood pours in), or the
    // reverse (the flood drains as the color returns to the assistant row).
    const goVisit = async () => {
      await duckUnder(pillEyes);
      if (cancelled) {
        return;
      }
      setVisiting(true);
      await surfaceAt(newConvEyes, [360, 16]);
      await blink();
    };
    const goHome = async () => {
      await duckUnder(newConvEyes);
      if (cancelled) {
        return;
      }
      setVisiting(false);
      await surfaceAt(pillEyes, [320, 18]);
    };

    // Collapsed rail: grow a touch, blink, settle back.
    const collapsedPulse = async () => {
      await move(pillEyes, { scale: 1.35 }, spring(300, 14));
      await blink();
      await sleep(jitter(250, 350));
      await move(pillEyes, { scale: 1 }, spring(300, 16));
    };

    // Short-tick loop so a hover on the New Chat row can summon the
    // eyes promptly; ambient acts fire on their own jittered schedule.
    const TICK_MS = 120;
    const run = async () => {
      // A rail toggle can restart the loop mid-visit — snap everything back
      // to the resting arrangement before starting over.
      setVisiting(false);
      let atNewConv = false;
      if (collapsed) {
        pillEyes.set({ x: 0, y: 0, scale: 1 });
      } else {
        pillEyes.set({ x: 0, y: restY, scale: REST_SCALE });
      }
      newConvEyes.set({ x: 0, y: diveY, scale: REST_SCALE });

      let idleMs = 0;
      let nextActAt = jitter(1600, 1600);
      /** How long the current stay in the New Chat row lasts. */
      let dwellMs = 0;
      while (!cancelled) {
        await sleep(TICK_MS);
        if (cancelled) {
          break;
        }
        if (collapsed || !showNewConversation) {
          idleMs += TICK_MS;
          if (idleMs >= nextActAt) {
            idleMs = 0;
            nextActAt = jitter(2800, 3200);
            await (collapsed ? collapsedPulse() : blink());
          }
          continue;
        }
        if (hoverRef.current) {
          // Summoned: head over (or stay) while the pointer lingers, and
          // head home almost immediately once it leaves.
          if (!atNewConv) {
            await goVisit();
            atNewConv = true;
          }
          idleMs = 0;
          dwellMs = 400;
          continue;
        }
        if (atNewConv) {
          idleMs += TICK_MS;
          if (idleMs >= dwellMs) {
            idleMs = 0;
            await goHome();
            atNewConv = false;
            nextActAt = jitter(1600, 1600);
          }
          continue;
        }
        idleMs += TICK_MS;
        if (idleMs >= nextActAt) {
          idleMs = 0;
          nextActAt = jitter(1600, 1600);
          if (Math.random() < 0.35) {
            await blink(); // resting blink between visits
          } else {
            await goVisit();
            atNewConv = true;
            dwellMs = jitter(1300, 1000);
          }
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
      pillEyes.stop();
      newConvEyes.stop();
    };
  }, [
    reduce,
    collapsed,
    showNewConversation,
    pillEyes,
    newConvEyes,
    restY,
    diveY,
  ]);

  const hex =
    (components &&
      traits &&
      components.colors.find((c) => c.id === traits.color)?.hex) ||
    null;

  if (!hex) {
    return (
      <div className="flex flex-col gap-[4px]">
        <SideMenu.Item
          icon={Brain}
          label={label}
          showCollapsedTooltip
          active={active}
          onSelect={onSelect}
        />
        {showNewConversation ? (
          <SideMenu.Item
            icon={SquarePen}
            label="New Chat"
            showCollapsedTooltip
            onSelect={onNewConversation}
          />
        ) : null}
      </div>
    );
  }

  // The name's tone on the avatar-colored row: white on every avatar color
  // except the light ones (yellow), where white would wash out.
  const fg = contrastForeground(hex);

  /** Right padding that keeps a row's text clear of the resting eyes' grown
   *  footprint (scale expands symmetrically from the sprite's center). */
  const textClearance =
    EYES_RIGHT_OFFSET + eyesWidth * REST_SCALE - ROW_PADDING_X;

  const eyesSprite = (
    controls: EyesControls,
    initial: { y: number; scale: number },
  ) =>
    eye && (
      <motion.span
        className="absolute left-0"
        style={{
          width: eyesWidth,
          height: eyesHeight,
          top: slotTop,
          transformOrigin: "50% 100%",
          y: initial.y,
          scale: initial.scale,
        }}
        initial={false}
        animate={controls}
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
              transformOrigin: `${eye.bbox.x + eye.bbox.w / 2}px ${eye.bbox.y + eye.bbox.h / 2}px`,
              transition: "transform 0.14s ease-in-out",
            }}
          >
            {eye.paths.map((p, i) => (
              <path key={i} d={p.svgPath} fill={p.color} />
            ))}
          </g>
        </svg>
      </motion.span>
    );

  /** The eyes' home slot, anchored to a row's right edge. */
  const eyesSlot = (
    controls: EyesControls,
    initial: { y: number; scale: number },
  ) => (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0"
      style={{ right: EYES_RIGHT_OFFSET, width: eyesWidth }}
    >
      {eyesSprite(controls, initial)}
    </span>
  );

  const assistantRow = (
    <button
      type="button"
      onClick={onSelect}
      title={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex w-full cursor-pointer items-center overflow-hidden rounded-[8px] select-none",
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        "transition-[filter,transform,background-color,color] duration-300 active:scale-[0.98]",
        visiting ? "hover:bg-[var(--surface-hover)]" : "hover:brightness-105",
        collapsed && "justify-center",
      )}
      style={{
        height: rowHeight,
        // While the eyes are visiting the row below, the color goes with
        // them — this row drains to a plain nav item until they return.
        backgroundColor: visiting ? "transparent" : hex,
        color: visiting ? "var(--content-default)" : fg,
        paddingLeft: collapsed ? 0 : ROW_PADDING_X,
        paddingRight: collapsed ? 0 : ROW_PADDING_X,
      }}
    >
      {collapsed ? (
        /* Collapsed rail: the eyes alone, centered, idling in place. */
        <span
          aria-hidden="true"
          className="pointer-events-none relative shrink-0"
          style={{ width: eyesWidth, height: rowHeight }}
        >
          {eyesSprite(pillEyes, { y: 0, scale: 1 })}
        </span>
      ) : (
        <>
          <span
            className={`min-w-0 flex-1 truncate text-left ${
              isMobile ? "text-body-large-default" : "text-body-medium-default"
            }`}
            style={{ paddingRight: textClearance }}
          >
            {label}
          </span>
          {eyesSlot(pillEyes, { y: restY, scale: REST_SCALE })}
        </>
      )}
    </button>
  );

  const newConversationRow = showNewConversation ? (
    <button
      type="button"
      onClick={onNewConversation}
      title="New Chat"
      onMouseEnter={() => {
        hoverRef.current = true;
      }}
      onMouseLeave={() => {
        hoverRef.current = false;
      }}
      className={cn(
        "group relative flex w-full cursor-pointer items-center gap-[6px] overflow-hidden rounded-[8px] select-none",
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        "transition-colors duration-150 hover:bg-[var(--surface-hover)] active:scale-[0.98]",
      )}
      style={{
        height: rowHeight,
        paddingLeft: ROW_PADDING_X,
        paddingRight: ROW_PADDING_X,
      }}
    >
      {/* The avatar-color "water" pouring in from where the eyes surface,
          mirroring the overview cards' flood (identity-overview.tsx). */}
      <motion.span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ backgroundColor: hex }}
        initial={false}
        animate={{
          clipPath: visiting
            ? `circle(141% at ${FLOOD_ORIGIN_X_PERCENT}% 100%)`
            : `circle(0% at ${FLOOD_ORIGIN_X_PERCENT}% 100%)`,
        }}
        transition={
          visiting
            ? { duration: 0.5, ease: "easeOut" }
            : { duration: 0.35, ease: "easeIn" }
        }
      />
      <span
        className={`relative min-w-0 flex-1 truncate text-left transition-colors duration-300 ${
          isMobile ? "text-body-large-default" : "text-body-medium-default"
        }`}
        style={{
          color: visiting ? contrastForeground(hex) : "var(--content-default)",
          paddingRight: textClearance,
        }}
      >
        New Chat
      </span>
      {/* Right-aligned pencil (the collapsed rail's new-chat glyph); it
          yields the corner to the eyes while they're visiting. */}
      <SquarePen
        className={cn(
          "relative h-3.5 w-3.5 shrink-0 transition-opacity duration-200",
          visiting && "opacity-0",
        )}
        style={{ color: "var(--content-tertiary)" }}
        aria-hidden
      />
      {eyesSlot(newConvEyes, { y: diveY, scale: REST_SCALE })}
    </button>
  ) : null;

  return (
    <div className="flex flex-col gap-[4px]">
      {assistantRow}
      {newConversationRow}
    </div>
  );
}
