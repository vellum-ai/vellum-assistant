/**
 * The sidebar's assistant cluster: a "New Chat" row — a plus glyph inside
 * a circular chip, label beside it — with the "Your Assistant" nav row
 * directly beneath, dressed up as the assistant: a standard-height row
 * painted solid in the avatar's color with the avatar's eyes sitting in
 * the leading icon slot, centered on the same axis as the New Chat chip
 * so the two rows' labels align.
 *
 * Periodically the eyes go on patrol: they sink out through the row's
 * bottom fold, resurface grown on the right side (cut off by the edge),
 * blink, and dive back under to reappear in the icon slot. Between
 * patrols they idle-blink in place (and pulse a touch on the collapsed
 * rail). They never leave the assistant row.
 *
 * The assistant name is never bolded and always renders white on the
 * avatar-colored row — except on light avatar colors (yellow), where it
 * flips dark for contrast.
 *
 * Falls back to a plain-toned row (a Brain icon in the same leading slot,
 * so both labels stay aligned) when there's no character avatar to dress
 * as (custom image / not loaded).
 */

import { Brain, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";

import { cn } from "@vellumai/design-library";

import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";
import { eyeStyleBaseWidth } from "@/utils/assistant-eyes";
import { contrastForeground } from "@/utils/avatar-tone";
import { pathBBox, unionBBox } from "@/utils/eye-bbox";

/** Standard nav-row height, matching `SideMenu.Item`. */
const ROW_HEIGHT = 30;
/** Mobile-overlay row height, matching `SideMenu.Item`'s mobile row. */
const MOBILE_ROW_HEIGHT = 44;
const ROW_PADDING_X = 6;
/**
 * Diameter of the New Chat row's circular plus chip; the assistant row's
 * leading eye slot is the same width so the eyes center on the chip's axis
 * and both labels start at the same x.
 */
const CHIP_SIZE = 20;
/** Patrol stop on the right side: grown, cut off by the bottom edge. */
const SIDE_SCALE = 2.1;
const SIDE_RIGHT_MARGIN = 14;

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
  // While the onboarding tour owns the nav rows (flooding them with its own
  // eyes treatment), this component's eyes and patrol loop stay completely
  // suppressed and the assistant row drains to a plain nav item.
  const navTourActive = useInChatOnboardingStore.use.navTourActive();
  const eyesControls = useAnimationControls();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
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
  const eyesWidth = eye ? eyeStyleBaseWidth(eye.id) : 0;
  const eyesHeight = eye ? eyesWidth * (eye.bbox.h / eye.bbox.w) : 0;

  const showNewConversation = Boolean(onNewConversation) && !collapsed;

  useEffect(() => {
    if (navTourActive) {
      // Snap home so a tour starting mid-patrol doesn't strand the sprite.
      eyesControls.set({ x: 0, y: 0, scale: 1 });
      return;
    }
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
      to: { x?: number; y?: number; scale?: number },
      transition: Record<string, unknown>,
    ) =>
      cancelled
        ? Promise.resolve()
        : eyesControls.start({ ...to, transition }).catch(() => {});

    /** How far down the eyes dive to fully exit the row's bottom edge. */
    const diveY = rowHeight - 4;
    /** Side-patrol stop: the grown eyes flush with the bottom edge. */
    const sidePeekY = rowHeight - 20;

    // The one expanded-rail act: dive out through the bottom fold, pop up
    // grown on the right side, blink, dive again, and slip back into the
    // icon slot.
    const patrol = async () => {
      await move({ y: diveY }, { duration: 0.3, ease: "easeIn" });
      if (cancelled) {
        return;
      }
      const width = buttonRef.current?.offsetWidth ?? 200;
      // x is relative to the sprite's home in the icon slot (row padding
      // plus its centering offset inside the chip-width slot).
      const homeLeft = ROW_PADDING_X + (CHIP_SIZE - eyesWidth) / 2;
      const sideX = Math.max(
        0,
        width - SIDE_RIGHT_MARGIN - eyesWidth * SIDE_SCALE - homeLeft,
      );
      eyesControls.set({ x: sideX, y: diveY, scale: SIDE_SCALE });
      await move({ y: sidePeekY }, spring(360, 16));
      await blink();
      await sleep(jitter(700, 900));
      await move({ y: diveY }, { duration: 0.3, ease: "easeIn" });
      eyesControls.set({ x: 0, y: diveY, scale: 1 });
      await move({ y: 0 }, spring(320, 18));
    };

    // Collapsed rail: grow a touch, blink, settle back.
    const collapsedPulse = async () => {
      await move({ scale: 1.35 }, spring(300, 14));
      await blink();
      await sleep(jitter(250, 350));
      await move({ scale: 1 }, spring(300, 16));
    };

    const run = async () => {
      // A rail toggle can restart the loop mid-patrol — snap the eyes back
      // to the icon slot before starting over.
      eyesControls.set({ x: 0, y: 0, scale: 1 });
      while (!cancelled) {
        await sleep(jitter(2800, 3200));
        if (cancelled) {
          break;
        }
        if (collapsed) {
          await collapsedPulse();
        } else if (Math.random() < 0.55) {
          await blink(); // resting blink between patrols
        } else {
          await patrol();
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
      eyesControls.stop();
    };
  }, [reduce, navTourActive, collapsed, eyesControls, rowHeight, eyesWidth]);

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
      data-tour-id="new-chat"
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
    // No character avatar (custom image / not loaded): a plain-toned row
    // that keeps the New Chat row's geometry — the Brain icon centers in
    // the same CHIP_SIZE slot the plus chip and the eyes use, so both
    // rows' labels stay on one axis.
    return (
      <div className="flex flex-col gap-[4px]">
        {newConversationRow}
        <button
          type="button"
          onClick={onSelect}
          title={label}
          data-tour-id="assistant-page"
          aria-current={active ? "page" : undefined}
          className={cn(
            "group relative flex w-full cursor-pointer items-center gap-[6px] overflow-hidden rounded-[8px] select-none",
            "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
            "transition-colors duration-150 active:scale-[0.98]",
            active
              ? "bg-[var(--surface-active)]"
              : "hover:bg-[var(--surface-hover)]",
            collapsed && "justify-center",
          )}
          style={{
            height: rowHeight,
            paddingLeft: collapsed ? 0 : ROW_PADDING_X,
            paddingRight: collapsed ? 0 : ROW_PADDING_X,
          }}
        >
          <span
            aria-hidden="true"
            className="flex shrink-0 items-center justify-center"
            style={{ width: CHIP_SIZE, height: CHIP_SIZE }}
          >
            <Brain
              className="h-3.5 w-3.5"
              style={{
                color: active
                  ? "var(--content-default)"
                  : "var(--content-tertiary)",
              }}
            />
          </span>
          {!collapsed && (
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-left",
                active
                  ? "text-[color:var(--content-emphasised)]"
                  : "text-[color:var(--content-secondary)]",
                isMobile ? "text-body-large-default" : "text-body-medium-lighter",
              )}
            >
              {label}
            </span>
          )}
        </button>
      </div>
    );
  }

  // The name's tone on the avatar-colored row: white on every avatar color
  // except the light ones (yellow), where white would wash out.
  const fg = contrastForeground(hex);

  const eyesSvg = eye && (
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
  );

  const assistantRow = (
    <button
      ref={buttonRef}
      type="button"
      onClick={onSelect}
      title={label}
      data-tour-id="assistant-page"
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex w-full cursor-pointer items-center gap-[6px] overflow-hidden rounded-[8px] select-none",
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        "transition-[filter,transform,background-color,color] duration-300 active:scale-[0.98]",
        navTourActive
          ? "hover:bg-[var(--surface-hover)]"
          : "hover:brightness-105",
        collapsed && "justify-center",
      )}
      style={{
        height: rowHeight,
        // While the tour owns the nav, the color leaves this row — it
        // drains to a plain nav item so the tour's flood is the only color
        // treatment on screen.
        backgroundColor: navTourActive ? "transparent" : hex,
        color: navTourActive ? "var(--content-default)" : fg,
        paddingLeft: collapsed ? 0 : ROW_PADDING_X,
        paddingRight: collapsed ? 0 : ROW_PADDING_X,
      }}
    >
      {collapsed ? (
        /* Collapsed rail: the eyes alone, centered, idling in place. */
        !navTourActive &&
        eye && (
          <motion.span
            className="pointer-events-none relative block"
            style={{
              width: eyesWidth,
              height: eyesHeight,
              transformOrigin: "50% 100%",
            }}
            initial={false}
            animate={eyesControls}
          >
            {eyesSvg}
          </motion.span>
        )
      ) : (
        <>
          {/* Leading eye slot, chip-width so the eyes center on the New
              Chat row's plus chip above; the sprite is absolutely placed
              so patrols can carry it across (and under) the whole row. */}
          <span
            aria-hidden="true"
            className="pointer-events-none relative flex shrink-0 items-center justify-center"
            style={{ width: CHIP_SIZE, height: rowHeight }}
          >
            {/* While the tour owns the nav the eyes leave the row — the
                Brain stands in, matching the no-avatar row's icon. */}
            {navTourActive && (
              <Brain
                className="h-3.5 w-3.5"
                style={{
                  color: active
                    ? "var(--content-default)"
                    : "var(--content-tertiary)",
                }}
              />
            )}
            {!navTourActive && eye && (
              <motion.span
                className="absolute"
                style={{
                  width: eyesWidth,
                  height: eyesHeight,
                  left: (CHIP_SIZE - eyesWidth) / 2,
                  top: (rowHeight - eyesHeight) / 2,
                  transformOrigin: "50% 100%",
                }}
                initial={false}
                animate={eyesControls}
              >
                {eyesSvg}
              </motion.span>
            )}
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
