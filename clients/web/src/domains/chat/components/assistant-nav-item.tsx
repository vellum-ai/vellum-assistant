/**
 * The sidebar's assistant cluster: a "New Chat" row — a plus glyph inside
 * a circular chip, label beside it — with the "Your Assistant" nav row
 * directly beneath, dressed up as the assistant: a standard-height row
 * painted solid in the avatar's color with the avatar's eyes sitting in
 * the leading icon slot, centered on the same axis as the New Chat chip
 * so the two rows' labels align.
 *
 * The eyes stay at their perch — they idle-blink in place (and pulse a
 * touch on the collapsed rail) but never leave the assistant row.
 *
 * The assistant name is never bolded and always renders white on the
 * avatar-colored row — except on light avatar colors (yellow), where it
 * flips dark for contrast.
 *
 * Falls back to a plain `SideMenu.Item` for the assistant row when
 * there's no character avatar to dress as (custom image / not loaded).
 */

import { Brain, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
 * Height follows each style's own aspect ratio at its width. Styles missing
 * from the map (a future catalog addition) fall back to
 * {@link DEFAULT_EYES_WIDTH}.
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
const ROW_PADDING_X = 6;
/**
 * Diameter of the New Chat row's circular plus chip; the assistant row's
 * leading eye slot is the same width so the eyes center on the chip's axis
 * and both labels start at the same x.
 */
const CHIP_SIZE = 20;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const jitter = (base: number, spread: number): number =>
  base + Math.random() * spread;

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
  /** Renders the "New Chat" row above the assistant row. */
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
  const eyesControls = useAnimationControls();
  const [blinking, setBlinking] = useState(false);

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
    const spring = (stiffness: number, damping: number) => ({
      type: "spring",
      stiffness,
      damping,
    });
    const move = (
      to: { scale?: number },
      transition: Record<string, unknown>,
    ) =>
      cancelled
        ? Promise.resolve()
        : eyesControls.start({ ...to, transition }).catch(() => {});

    // Collapsed rail: grow a touch, blink, settle back.
    const collapsedPulse = async () => {
      await move({ scale: 1.35 }, spring(300, 14));
      await blink();
      await sleep(jitter(250, 350));
      await move({ scale: 1 }, spring(300, 16));
    };

    const run = async () => {
      // A rail toggle can restart the loop mid-pulse — snap the eyes back
      // to rest before starting over.
      eyesControls.set({ scale: 1 });
      while (!cancelled) {
        await sleep(jitter(2800, 3200));
        if (cancelled) {
          break;
        }
        await (collapsed ? collapsedPulse() : blink());
      }
    };
    void run();
    return () => {
      cancelled = true;
      eyesControls.stop();
    };
  }, [reduce, collapsed, eyesControls]);

  const hex =
    (components &&
      traits &&
      components.colors.find((c) => c.id === traits.color)?.hex) ||
    null;

  const newConversationRow = showNewConversation ? (
    <button
      type="button"
      onClick={onNewConversation}
      title="New Chat"
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
      <span
        aria-hidden="true"
        className="flex shrink-0 items-center justify-center rounded-full bg-[var(--surface-active)]"
        style={{ width: CHIP_SIZE, height: CHIP_SIZE }}
      >
        <Plus
          className="h-3.5 w-3.5"
          style={{ color: "var(--content-emphasised)" }}
        />
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-left text-[color:var(--content-secondary)] ${
          isMobile ? "text-body-large-default" : "text-body-medium-lighter"
        }`}
      >
        New Chat
      </span>
    </button>
  ) : null;

  if (!hex) {
    return (
      <div className="flex flex-col gap-[4px]">
        {newConversationRow}
        <SideMenu.Item
          icon={Brain}
          label={label}
          showCollapsedTooltip
          active={active}
          onSelect={onSelect}
        />
      </div>
    );
  }

  // The name's tone on the avatar-colored row: white on every avatar color
  // except the light ones (yellow), where white would wash out.
  const fg = contrastForeground(hex);

  const eyesSprite = eye && (
    <motion.span
      className="pointer-events-none relative block"
      style={{ width: eyesWidth, height: eyesHeight }}
      initial={false}
      animate={eyesControls}
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

  const assistantRow = (
    <button
      type="button"
      onClick={onSelect}
      title={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex w-full cursor-pointer items-center gap-[6px] overflow-hidden rounded-[8px] select-none",
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        "transition-[filter,transform] duration-300 hover:brightness-105 active:scale-[0.98]",
        collapsed && "justify-center",
      )}
      style={{
        height: rowHeight,
        backgroundColor: hex,
        color: fg,
        paddingLeft: collapsed ? 0 : ROW_PADDING_X,
        paddingRight: collapsed ? 0 : ROW_PADDING_X,
      }}
    >
      {collapsed ? (
        /* Collapsed rail: the eyes alone, centered, idling in place. */
        eyesSprite
      ) : (
        <>
          {/* Leading eye slot, chip-width so the eyes center on the New
              Chat row's plus chip above. */}
          <span
            aria-hidden="true"
            className="flex shrink-0 items-center justify-center"
            style={{ width: CHIP_SIZE }}
          >
            {eyesSprite}
          </span>
          <span
            className={`min-w-0 flex-1 truncate text-left ${
              isMobile ? "text-body-large-default" : "text-body-medium-default"
            }`}
          >
            {label}
          </span>
        </>
      )}
    </button>
  );

  return (
    <div className="flex flex-col gap-[4px]">
      {newConversationRow}
      {assistantRow}
    </div>
  );
}
