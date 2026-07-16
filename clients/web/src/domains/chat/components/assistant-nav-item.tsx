/**
 * The sidebar's "Your Assistant" nav item, dressed up as the assistant: a
 * standard-height row painted solid in the avatar's color (Figma: New-App
 * 6944-89505), with the avatar's eyes sitting in the leading icon slot —
 * so the label aligns with the other nav items below.
 *
 * Periodically the eyes go on patrol: they sink out through the pill's
 * bottom edge, resurface grown on the right side (cut off by the edge,
 * like the old peek), perform one random gesture — swoosh, double bounce,
 * pulse, or waddle — and dive back under to reappear in the icon slot.
 * Between patrols they idle-blink in place.
 *
 * Falls back to a plain `SideMenu.Item` when there's no character avatar
 * to dress as (custom image / not loaded).
 */

import { Brain } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";

import { cn, SideMenu } from "@vellumai/design-library";

import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { contrastForeground } from "@/utils/avatar-tone";
import { pathBBox, unionBBox } from "@/utils/eye-bbox";

const PILL_HEIGHT = 30;
/** Mobile-overlay pill height, matching `SideMenu.Item`'s mobile row
 *  (py-3 around the 20px body-large line). */
const MOBILE_PILL_HEIGHT = 44;
/** Eyes sized to the 14px leading-icon slot of `SideMenu.Item`, so the
 *  label aligns with the nav items below. */
const EYES_WIDTH = 14;
/** Horizontal padding of the pill (matches SideMenu.Item's p-[6px]). */
const PILL_PADDING_X = 6;
/** Patrol stop on the right side: grown, cut off by the bottom edge. */
const SIDE_SCALE = 2.1;
const SIDE_RIGHT_MARGIN = 14;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const jitter = (base: number, spread: number): number =>
  base + Math.random() * spread;

interface AssistantNavItemProps {
  assistantId: string | null;
  label: string;
  active: boolean;
  collapsed?: boolean;
  onSelect?: () => void;
}

export function AssistantNavItem({
  assistantId,
  label,
  active,
  collapsed = false,
  onSelect,
}: AssistantNavItemProps) {
  const { components, traits } = useAssistantAvatar(assistantId);
  const reduce = useReducedMotion();
  const isMobile = useIsMobile();
  const eyesControls = useAnimationControls();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [blinking, setBlinking] = useState(false);

  const pillHeight = isMobile ? MOBILE_PILL_HEIGHT : PILL_HEIGHT;
  /** How far down the eyes dive to fully exit the pill's bottom edge. */
  const diveY = pillHeight - 4;
  /** Side-patrol stop: the grown eyes flush with the bottom edge. */
  const sidePeekY = pillHeight - 20;

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
      to: { x?: number; y?: number; scale?: number },
      transition: Record<string, unknown>,
    ) =>
      cancelled
        ? Promise.resolve()
        : eyesControls.start({ ...to, transition }).catch(() => {});
    const spring = (stiffness: number, damping: number) => ({
      type: "spring",
      stiffness,
      damping,
    });

    // The one expanded-rail act: dive out through the bottom edge, pop up
    // grown on the right side, blink, dive again, and slip back into the
    // icon slot.
    const patrol = async () => {
      await move({ y: diveY }, { duration: 0.3, ease: "easeIn" });
      if (cancelled) {
        return;
      }
      const width = buttonRef.current?.offsetWidth ?? 200;
      const sideX = Math.max(
        0,
        width - PILL_PADDING_X - SIDE_RIGHT_MARGIN - EYES_WIDTH * SIDE_SCALE,
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
      // A rail toggle can restart the loop mid-patrol — snap the eyes
      // back to the icon slot before starting over.
      eyesControls.set({ x: 0, y: 0, scale: 1 });
      while (!cancelled) {
        await sleep(jitter(2800, 3200));
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
  }, [reduce, collapsed, eyesControls, diveY, sidePeekY]);

  const hex =
    (components &&
      traits &&
      components.colors.find((c) => c.id === traits.color)?.hex) ||
    null;

  const eye = useMemo(() => {
    if (!components || !traits) {
      return null;
    }
    const def = components.eyeStyles.find((e) => e.id === traits.eyeStyle);
    if (!def) {
      return null;
    }
    return {
      paths: def.paths,
      bbox: unionBBox(def.paths.map((p) => pathBBox(p.svgPath))),
    };
  }, [components, traits]);

  if (!hex) {
    return (
      <SideMenu.Item
        icon={Brain}
        label={label}
        showCollapsedTooltip
        active={active}
        onSelect={onSelect}
      />
    );
  }

  const eyesHeight = eye ? EYES_WIDTH * (eye.bbox.h / eye.bbox.w) : 0;

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onSelect}
      title={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex w-full cursor-pointer items-center gap-[6px] overflow-hidden rounded-[8px] select-none",
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        "transition-[filter,transform] duration-150 hover:brightness-105 active:scale-[0.98]",
        collapsed ? "justify-center px-0" : "px-[6px]",
      )}
      style={{
        height: pillHeight,
        backgroundColor: hex,
        color: contrastForeground(hex),
      }}
    >
      {/* The eyes live in the leading icon slot, so the label lines up
          with the nav items below. */}
      <span
        aria-hidden="true"
        className="pointer-events-none relative shrink-0"
        style={{ width: EYES_WIDTH, height: pillHeight }}
      >
        {eye && (
          <motion.span
            className="absolute left-0"
            style={{
              width: EYES_WIDTH,
              height: eyesHeight,
              top: (pillHeight - eyesHeight) / 2,
              transformOrigin: "50% 100%",
            }}
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
        )}
      </span>
      {!collapsed && (
        <span
          className={`truncate ${
            isMobile ? "text-body-large-default" : "text-body-medium-default"
          } ${active ? "font-bold" : ""}`}
        >
          {label}
        </span>
      )}
    </button>
  );
}
