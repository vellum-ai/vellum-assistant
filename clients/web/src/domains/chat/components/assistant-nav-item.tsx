/**
 * The sidebar's assistant cluster: the "Your Assistant" nav row, dressed up
 * as the assistant (a standard-height row painted solid in the avatar's color
 * with the avatar's eyes sitting in the leading icon slot), and a "New Chat"
 * row directly beneath it: a plus glyph with a label beside it, on the same
 * avatar-tinted wash the identity page's feature cards wear. The plus centers
 * on the same axis as the eyes, so the two rows' labels align. On the
 * collapsed rail both rows survive as icon-only tiles (Figma 7257:135811).
 *
 * The eyes hold their place in the leading slot and blink there periodically.
 * They do not travel: the pill is sized to the assistant's name, so there is
 * nowhere inside it for a grown sprite to go that is not on top of that name.
 *
 * The collapsed rail is the exception, and keeps its pulse: its tile centres
 * the eyes with nothing beside them, so growing has room there.
 *
 * The assistant name is never bolded and always renders white on the
 * avatar-colored row — except on light avatar colors (yellow), where it
 * flips dark for contrast.
 *
 * Falls back to a plain-toned row (a Brain icon in the same leading slot,
 * so both labels stay aligned) when there's no character avatar to dress
 * as (custom image / not loaded).
 */

import { SIDEBAR_STACK_GAP } from "@/components/sidebar-nav-geometry";
import { Brain, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";

import type { CSSProperties } from "react";

import { cn, PanelItem } from "@vellumai/design-library";

import {
  SIDEBAR_CHIP_GAP,
  SIDEBAR_CHIP_SIZE as CHIP_SIZE,
} from "@/components/sidebar-nav-geometry";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";
import { eyeStyleBaseWidth } from "@/utils/assistant-eyes";
import { contrastForeground } from "@/utils/avatar-tone";
import { pathBBox, unionBBox } from "@/utils/eye-bbox";

/** Collapsed-rail assistant tile height (Figma 7257:135820). */
/* Matches the circle `SideMenu.Item` and the section triggers render on the
   rail: every tile there is the same 30px circle, so one step runs the whole
   column. Diverging from it drifts this cluster against the sections. */
const COLLAPSED_ASSISTANT_TILE = 30;
/** How far the collapsed rail's tile grows the eyes on a pulse. */
const PULSE_SCALE = 1.35;

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
  /** Renders the "New Chat" row below the assistant row. */
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
  // While the onboarding tour owns the nav rows (flooding them with its own
  // eyes treatment), this component's eyes and its loop stay completely
  // suppressed and the assistant row drains to a plain nav item.
  const navTourActive = useInChatOnboardingStore.use.navTourActive();
  /* Drives the collapsed rail's pulse only. The expanded row's eyes hold still,
     so nothing there subscribes to these controls and the loop leaves them
     alone while the rail is open. */
  const eyesControls = useAnimationControls();
  const [blinking, setBlinking] = useState(false);

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

  const showNewConversation = Boolean(onNewConversation);

  useEffect(() => {
    if (navTourActive) {
      /* Snap back to rest so a tour starting mid-pulse doesn't strand the
         sprite grown. Guarded, as every controls call here is: only the
         collapsed tile subscribes to them. */
      if (collapsed) {
        eyesControls.set({ scale: 1 });
      }
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
      to: { scale?: number },
      transition: Record<string, unknown>,
    ) =>
      cancelled
        ? Promise.resolve()
        : eyesControls.start({ ...to, transition }).catch(() => {});

    // Collapsed rail: grow a touch, blink, settle back. The rail's tile centres
    // the sprite with nothing beside it, so the pulse has room the expanded
    // row's leading slot does not.
    const collapsedPulse = async () => {
      await move({ scale: PULSE_SCALE }, spring(300, 14));
      await blink();
      await sleep(jitter(250, 350));
      await move({ scale: 1 }, spring(300, 16));
    };

    const run = async () => {
      // A rail toggle can restart the loop mid-pulse, so start from rest.
      if (collapsed) {
        eyesControls.set({ scale: 1 });
      }
      while (!cancelled) {
        await sleep(jitter(2800, 3200));
        if (cancelled) {
          break;
        }
        if (collapsed) {
          await collapsedPulse();
        } else {
          await blink();
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (collapsed) {
        eyesControls.stop();
      }
    };
  }, [reduce, navTourActive, collapsed, eyesControls]);

  const hex =
    (components &&
      traits &&
      components.colors.find((c) => c.id === traits.color)?.hex) ||
    null;

  /* An untinted pill. It sat on a 14% wash of the avatar colour, which put
     two tinted surfaces next to each other with only the identity pill
     needing to carry the assistant's colour. Plain reads better beside it,
     and it drops the one place a leading icon and its label wanted different
     colours.

     Collapsed, it becomes the same square glyph tile the identity above it
     uses rather than a pill with its label dropped: a pill is sized by its
     content, so on a 48px rail one keeping its label overflows the rail
     entirely. */
  const newConversationRow = !showNewConversation ? null : collapsed ? (
    <button
      type="button"
      onClick={onNewConversation}
      title="New Chat"
      data-tour-id="new-chat"
      className={cn(
        "group relative flex shrink-0 self-center cursor-pointer items-center justify-center overflow-hidden select-none",
        "rounded-full",
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        "transition-colors duration-150 active:scale-[0.98]",
        "bg-[var(--panel-item-bg,var(--surface-lift))]",
        "[@media(hover:hover)]:hover:bg-[var(--panel-item-hover,var(--surface-hover))]",
      )}
      style={{
        width: COLLAPSED_ASSISTANT_TILE,
        height: COLLAPSED_ASSISTANT_TILE,
      }}
    >
      {/* 14px, not the section headers' 12px - the plus glyph carries less
          ink than the pin/chat icons, so it needs the extra 2px to read at
          the same weight beside them. */}
      <Plus
        aria-hidden="true"
        className="h-3.5 w-3.5"
        style={{ color: "var(--content-tertiary)" }}
      />
    </button>
  ) : (
    <PanelItem
      shape="pill"
      icon={Plus}
      label="New Chat"
      onSelect={onNewConversation}
      data-tour-id="new-chat"
    />
  );

  if (!hex) {
    // No character avatar (custom image / not loaded): a plain-toned row
    // that keeps the New Chat row's geometry — the Brain icon centers in
    // the same CHIP_SIZE slot the plus chip and the eyes use, so both
    // rows' labels stay on one axis.
    return (
      <div className={cn("flex flex-col", SIDEBAR_STACK_GAP)}>
        {collapsed ? (
          <button
            type="button"
            onClick={onSelect}
            title={label}
            data-tour-id="assistant-page"
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex shrink-0 self-center cursor-pointer items-center justify-center overflow-hidden select-none",
              "rounded-full",
              "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
              "transition-colors duration-150 active:scale-[0.98]",
              "bg-[var(--panel-item-bg,var(--surface-lift))]",
              active
                ? "bg-[var(--surface-active)]"
                : "[@media(hover:hover)]:hover:bg-[var(--panel-item-hover,var(--surface-hover))]",
            )}
            style={{
              width: COLLAPSED_ASSISTANT_TILE,
              height: COLLAPSED_ASSISTANT_TILE,
            }}
          >
            <Brain
              className="h-3.5 w-3.5"
              style={{
                color: active
                  ? "var(--content-default)"
                  : "var(--content-tertiary)",
              }}
            />
          </button>
        ) : (
          /* No character avatar, so nothing declares the tint properties and
             the pill wears its plain surface. Same component as the tinted
             one below: the colour is the only difference between them. */
          <PanelItem
            shape="pill"
            icon={Brain}
            label={label}
            active={active}
            onSelect={onSelect}
            data-tour-id="assistant-page"
          />
        )}
        {newConversationRow}
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

  /* The assistant's own colour, declared as the pill's tint properties
     rather than passed to `PanelItem` or written over its classes. Hover
     lightens the same hue, which is what the bespoke row did with
     `brightness-105`. While the tour owns the nav the colour drains away
     entirely: nothing is declared, so the pill falls back to its plain
     surface and the tour's flood is the only colour on screen. */
  const tintStyle =
    !navTourActive && hex
      ? ({
          "--panel-item-bg": hex,
          "--panel-item-fg": fg,
          "--panel-item-hover": `color-mix(in srgb, #fff 8%, ${hex})`,
        } as CSSProperties)
      : undefined;

  /* The eyes, holding still in the pill's leading slot: centred in the same
     chip-width box the plus glyph and the section icons use, so the cluster's
     labels stay on one axis. They blink where they sit and go nowhere else,
     which is what keeps them off the name beside them. */
  const eyesSlot = (
    <span
      aria-hidden="true"
      className="pointer-events-none relative flex shrink-0 items-center justify-center"
      style={{ width: CHIP_SIZE, height: CHIP_SIZE }}
    >
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
        <span
          className="absolute"
          style={{
            width: eyesWidth,
            height: eyesHeight,
            left: (CHIP_SIZE - eyesWidth) / 2,
            top: (CHIP_SIZE - eyesHeight) / 2,
          }}
        >
          {eyesSvg}
        </span>
      )}
    </span>
  );

  const assistantRow = collapsed ? (
    /* The collapsed rail keeps its own tile: it is a destination reduced to a
       glyph, not a pill with its label dropped, and it centres the sprite
       rather than leading with it. */
    <button
      type="button"
      onClick={onSelect}
      title={label}
      data-tour-id="assistant-page"
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex shrink-0 self-center cursor-pointer items-center justify-center overflow-hidden select-none",
        "rounded-full",
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        "transition-[filter,transform,background-color,color] duration-300 active:scale-[0.98]",
        "bg-[var(--panel-item-bg,var(--surface-lift))]",
        navTourActive
          ? "[@media(hover:hover)]:hover:bg-[var(--panel-item-hover,var(--surface-hover))]"
          : "hover:brightness-105",
      )}
      style={{
        width: COLLAPSED_ASSISTANT_TILE,
        height: COLLAPSED_ASSISTANT_TILE,
        gap: SIDEBAR_CHIP_GAP,
        backgroundColor: navTourActive ? "transparent" : hex,
        color: navTourActive ? "var(--content-default)" : fg,
      }}
    >
      {!navTourActive && eye && (
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
      )}
    </button>
  ) : (
    <span style={tintStyle}>
      <PanelItem
        shape="pill"
        leadingSlot={eyesSlot}
        label={label}
        active={active}
        onSelect={onSelect}
        data-tour-id="assistant-page"
      />
    </span>
  );

  return (
    <div className={cn("flex flex-col", SIDEBAR_STACK_GAP)}>
      {assistantRow}
      {newConversationRow}
    </div>
  );
}
