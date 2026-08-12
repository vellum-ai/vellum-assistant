/**
 * The sidebar's assistant cluster: the "Your Assistant" nav row, dressed up
 * as the assistant (a standard-height row painted solid in the avatar's color
 * with the avatar's eyes sitting in the leading icon slot), and a "New Chat"
 * row directly beneath it: a plus glyph with a label beside it, on a wash of
 * the same color, the recipe the identity page's feature cards wear. The plus
 * centers on the same axis as the eyes, so the two rows' labels align. On the
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
 * The leading slot holds whichever avatar the assistant has: the character's
 * eyes, or an uploaded image in their place, both at the slot's full width so
 * the row's geometry does not change between them. An uploaded image wears the
 * plain pill rather than a tinted one, since a colour is read from a
 * character's palette and nothing derives one from an image.
 *
 * With neither, the row falls back to a plain-toned one with a Brain icon in
 * that slot, so the cluster's labels stay aligned.
 */

import { SIDEBAR_STACK_GAP } from "@/components/sidebar-nav-geometry";
import { Brain, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";

import {
  cn,
  PanelItem,
  panelItemWashStyle,
  SIDE_MENU_TILE_SIZE,
  type CustomPropertyStyle,
} from "@vellumai/design-library";

import {
  SIDEBAR_CHIP_GAP,
  SIDEBAR_CHIP_SIZE as CHIP_SIZE,
} from "@/components/sidebar-nav-geometry";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";
import { eyeStyleBaseWidth } from "@/utils/assistant-eyes";
import { contrastForeground } from "@/utils/avatar-tone";
import { pathBBox, unionBBox } from "@/utils/eye-bbox";

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
  const { components, traits, customImageUrl } =
    useAssistantAvatar(assistantId);
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

  /* A wash of the assistant's colour under the identity pill's solid fill, at
     the same depth the pinned apps below it wear, so the column's tinted rows
     agree. Without a character avatar there is no hue to mix and nothing is
     declared, leaving the plain surface both the pill and the tile fall back
     to; while the tour owns the nav the wash drains with the identity pill's
     fill.

     Collapsed, the row becomes the same square glyph tile the identity above
     it uses rather than a pill with its label dropped: a pill is sized by its
     content, so one keeping its label overflows the collapsed rail
     entirely. */
  const newConversationTint: CustomPropertyStyle | undefined =
    !navTourActive && hex
      ? {
          ...panelItemWashStyle(hex),
          // The plus glyph reads as the assistant's own accent, not the
          // row's usual tertiary-gray icon: the row's other icons are
          // decorative wayfinding, but this one's action is "start a chat
          // with this assistant", so it wears the assistant's colour.
          "--panel-item-icon-fg": hex,
        }
      : undefined;
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
        ...newConversationTint,
        width: SIDE_MENU_TILE_SIZE,
        height: SIDE_MENU_TILE_SIZE,
      }}
    >
      {/* 14px, not the section headers' 12px - the plus glyph carries less
          ink than the pin/chat icons, so it needs the extra 2px to read at
          the same weight beside them. Color matches the expanded pill's
          plus: the assistant's own accent via `--panel-item-icon-fg`
          (spread into this button's style from `newConversationTint`
          above), falling back to the usual tertiary gray with no
          character avatar to draw a hue from. */}
      <Plus
        aria-hidden="true"
        className="h-3.5 w-3.5"
        style={{ color: "var(--panel-item-icon-fg, var(--content-tertiary))" }}
      />
    </button>
  ) : (
    <PanelItem
      shape="pill"
      icon={Plus}
      label="New Chat"
      onSelect={onNewConversation}
      style={newConversationTint}
      data-tour-id="new-chat"
    />
  );

  /* An uploaded image stands in for the character avatar this row otherwise
     dresses as. It fills the same CHIP_SIZE slot the eyes occupy, so the row
     reads the same whichever kind of avatar the assistant has, and it is
     `rounded-full object-cover` as every other surface renders it.

     Not `ChatAvatar`: that would also replace the Brain for assistants with no
     avatar at all, since it falls back to a generated default character and
     then to a "V", and it brings a mount spring and the poke sound into a nav
     row. Only the uploaded-image case wants changing here.

     Suppressed while the tour owns the nav, matching the way the character
     avatar's colour drains and the Brain stands in for its eyes. */
  /* One answer to "is there an uploaded image to wear", read by both the
     expanded slot and the collapsed tile so the two cannot disagree. A url
     rather than a boolean, so each render site has the value it needs. */
  const uploadedAvatarUrl = navTourActive ? null : customImageUrl;

  const avatarImage =
    uploadedAvatarUrl !== null ? (
      <span
        aria-hidden="true"
        className="pointer-events-none flex shrink-0 items-center justify-center"
        style={{ width: CHIP_SIZE, height: CHIP_SIZE }}
      >
        <img
          src={uploadedAvatarUrl}
          alt=""
          width={CHIP_SIZE}
          height={CHIP_SIZE}
          className="rounded-full object-cover"
          style={{ width: CHIP_SIZE, height: CHIP_SIZE }}
        />
      </span>
    ) : null;

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
              width: SIDE_MENU_TILE_SIZE,
              height: SIDE_MENU_TILE_SIZE,
            }}
          >
            {/* The uploaded image fills the tile, as an avatar rather than a
                glyph sitting on a surface. The tile is already round and
                clipping, so it needs no rounding of its own. */}
            {uploadedAvatarUrl !== null ? (
              <img
                src={uploadedAvatarUrl}
                alt=""
                aria-hidden="true"
                width={SIDE_MENU_TILE_SIZE}
                height={SIDE_MENU_TILE_SIZE}
                className="h-full w-full object-cover"
              />
            ) : (
              <Brain
                className="h-3.5 w-3.5"
                style={{
                  color: active
                    ? "var(--content-default)"
                    : "var(--content-tertiary)",
                }}
              />
            )}
          </button>
        ) : (
          /* No character avatar, so nothing declares the tint properties and
             the pill wears its plain surface. Same component and same
             geometry as the tinted one below: the colour is the only
             difference between them. */
          <PanelItem
            shape="pill"
            icon={Brain}
            leadingSlot={avatarImage ?? undefined}
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
  const tintStyle: CustomPropertyStyle | undefined =
    !navTourActive && hex
      ? {
          "--panel-item-bg": hex,
          "--panel-item-fg": fg,
          "--panel-item-hover": `color-mix(in srgb, #fff 8%, ${hex})`,
        }
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
        width: SIDE_MENU_TILE_SIZE,
        height: SIDE_MENU_TILE_SIZE,
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
