import { useTranslation } from "@/i18n";
/**
 * The sidebar's assistant cluster: the "Your Assistant" nav row, dressed up
 * as the assistant (Figma 8300:167392: a pill washed in the avatar's colour,
 * leading with a 32px disc painted solid in that colour with the avatar's
 * eyes in it, inset 2px from the pill's edge, and the name 6px after the
 * disc in the emphasised ink), and a "New Chat" row directly beneath it: a
 * plus glyph with a label beside it, on the same wash, the recipe the
 * identity page's feature cards wear. On the collapsed rail both rows
 * survive as icon-only tiles (Figma 7257:135811).
 *
 * The eyes hold their place in the leading slot and blink there periodically.
 * They do not travel: the pill is sized to the assistant's name, so there is
 * nowhere inside it for a grown sprite to go that is not on top of that name.
 *
 * The collapsed rail is the exception, and keeps its pulse: its tile centres
 * the eyes with nothing beside them, so growing has room there.
 *
 * The assistant name renders in the emphasised content ink at the medium
 * weight, on the wash; only the collapsed tile is painted solid, and there
 * the eyes stand alone, so the contrast foreground matters on the tile only.
 *
 * The leading disc holds whichever avatar the assistant has: the character's
 * eyes on the solid colour, or an uploaded image filling the disc in their
 * place, so the row's geometry does not change between them. An uploaded
 * image wears the plain pill rather than a washed one, since a colour is read
 * from a character's palette and nothing derives one from an image.
 *
 * With neither, the row falls back to a plain-toned one with a Brain icon in
 * a disc-sized slot, so the cluster's labels stay aligned.
 */

import { SIDEBAR_STACK_GAP } from "@/components/sidebar-nav-geometry";
import { Brain, Plus } from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";

import {
  cn,
  PanelItem,
  panelItemWashStyle,
  SIDE_MENU_TILE_SIZE,
  Tooltip,
  type CustomPropertyStyle,
} from "@vellumai/design-library";

import {
  SIDEBAR_ASSISTANT_DISC_SIZE as DISC_SIZE,
  SIDEBAR_CHIP_GAP,
  SIDEBAR_CHIP_SIZE as CHIP_SIZE,
} from "@/components/sidebar-nav-geometry";
import { useCommandShortcutHint } from "@/hooks/use-command-shortcut";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";
import { eyeStyleBaseWidth } from "@/utils/assistant-eyes";
import { toneForBg } from "@/utils/avatar-tone";

/**
 * The pill's leading disc (Figma 8300:167392): 32px in the 36px pill, inset
 * 2px from its edge (the `pl-[2px] py-[2px]` below), with the label
 * {@link DISC_GAP} after it. The disc holds the eyes' {@link CHIP_SIZE} chip
 * centred, so the eyes sit on the same axis they did in the bare chip and
 * the section glyphs below still centre on them.
 */
const DISC_GAP = 6;

/**
 * The pill's own geometry and type over `PanelItem`'s: the disc's inset in
 * place of the pill's 8px padding on the leading edge and the vertical (the
 * touch pill keeps its 44px by centring the disc in it), the name in the
 * emphasised ink at the medium weight the design sets it in. `font-medium!`
 * because the row's own `text-body-medium-lighter` pins a 400 weight that a
 * plain utility loses to.
 */
const DISC_PILL_CLASSES =
  "pl-[2px] py-[2px] max-md:py-[6px] font-medium! text-[var(--content-emphasised)]";
const DISC_PILL_STYLE: CustomPropertyStyle = {
  "--panel-item-gap": `${DISC_GAP}px`,
};

/**
 * The hover flood, the identity page's feature-card takeover in miniature:
 * a layer of the avatar's colour under the pill's content, clipped to the
 * disc at rest and growing from the disc's centre to cover the capsule on
 * hover, so the disc reads as swelling to fill its pill. The same timing
 * the cards use, 0.5s out on the way in and 0.35s in on the way out, and
 * only where a pointer can hover: a touch has no rest state to return to.
 * While the assistant page is the current page the pill holds the flooded
 * look, so the place the user is standing wears the full colour.
 *
 * The clip's circle is anchored on the disc's centre, 2px of inset plus its
 * 16px radius from the leading edge and halfway down, and the flooded
 * radius is 141% (the far corner of a wide capsule sits about its full
 * width from that point, and the percentage's reference is the box's
 * diagonal over root two, so 100% falls short of it).
 *
 * `-z-10` puts the layer under the label and the disc; `isolate` on the
 * pill keeps that below-content position from also being below the pill's
 * own background, which would hide it entirely.
 */
const FLOOD_CLASSES = cn(
  "pointer-events-none absolute inset-0 -z-10",
  "[clip-path:circle(16px_at_18px_50%)]",
  "transition-[clip-path] duration-[350ms] ease-in motion-reduce:transition-none",
  "[@media(hover:hover)]:group-hover/panel-item:[clip-path:circle(141%_at_18px_50%)]",
  "[@media(hover:hover)]:group-hover/panel-item:duration-500",
  "[@media(hover:hover)]:group-hover/panel-item:ease-out",
  "group-aria-[current=page]/panel-item:[clip-path:circle(141%_at_18px_50%)]",
);
/* The pill under the flood: a stacking context and a clip for the layer,
   and the name in the flood's own contrast ink while it is covered, on hover
   and on the current page alike. `!` on both, so they beat `PanelItem`'s own
   current-page ink at the same specificity. */
const FLOODED_PILL_CLASSES = cn(
  "isolate overflow-hidden transition-colors duration-300",
  "[@media(hover:hover)]:hover:text-[color:var(--pill-flood-fg)]!",
  "aria-[current=page]:text-[color:var(--pill-flood-fg)]!",
);
import { pathBBox, unionBBox } from "@/utils/eye-bbox";

/** How far the collapsed rail's tile grows the eyes on a pulse. */
const PULSE_SCALE = 1.35;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const jitter = (base: number, spread: number): number =>
  base + Math.random() * spread;

function NewChatTooltip({
  children,
  side,
}: {
  children: ReactElement;
  side: "right" | "top";
}) {
  const { t } = useTranslation("chat");
  const hint = useCommandShortcutHint("newConversation");
  return (
    <Tooltip
      content={
        <span className="inline-flex items-center gap-1.5">
          {t("assistantNavItem.newChat")}
          <span className="opacity-80">{hint}</span>
        </span>
      }
      side={side}
    >
      {children}
    </Tooltip>
  );
}

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
  /**
   * Trailing control inside the expanded pill (the switcher's chevron). The
   * collapsed rail's tile has no slot for it, and the tour suppresses it with
   * the rest of the identity treatment.
   */
  trailingAction?: ReactNode;
  /**
   * Replaces the assistant row entirely (the switcher's expanded card),
   * leaving the New Chat row in place beneath. Ignored on the collapsed rail
   * and while the tour owns the nav.
   */
  expansion?: ReactNode;
  /**
   * Stands beside the pill on its own row, a step after the name (the
   * toggle for the assistant's own section). Off the collapsed rail, whose
   * tile has no row, and out of the tour's drained nav, like
   * `trailingAction`; and gone while an `expansion` holds the row.
   */
  aside?: ReactNode;
  /**
   * Rendered directly beneath the assistant row, above New Chat (the
   * assistant's own section, when the `aside` has opened it). Ignored on the
   * collapsed rail and while the tour owns the nav.
   */
  beneath?: ReactNode;
}

export function AssistantNavItem({
  assistantId,
  label,
  active,
  collapsed = false,
  onSelect,
  onNewConversation,
  trailingAction,
  expansion,
  aside,
  beneath,
}: AssistantNavItemProps) {
  const { t } = useTranslation("chat");
  const {
    components,
    traits,
    customImageUrl,
    accentHex: hex,
  } = useAssistantAvatar(assistantId);
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

  /* A wash of the assistant's colour under the identity pill's solid fill, at
     the same depth the pinned apps below it wear, so the column's tinted rows
     agree. Without an avatar colour there is no hue to mix and nothing is
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
    <NewChatTooltip side="right">
      <button
        type="button"
        onClick={onNewConversation}
        aria-label={t("assistantNavItem.newChat")}
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
          style={{
            color: "var(--panel-item-icon-fg, var(--content-tertiary))",
          }}
        />
      </button>
    </NewChatTooltip>
  ) : (
    <NewChatTooltip side="top">
      <PanelItem
        shape="pill"
        icon={Plus}
        label={t("assistantNavItem.newChat")}
        onSelect={onNewConversation}
        style={newConversationTint}
        data-tour-id="new-chat"
      />
    </NewChatTooltip>
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

  /* The switcher's affordances follow the identity treatment: the collapsed
     tile has no slot for a trailing control, and the tour's drained nav must
     not carry a live switcher. */
  const pillTrailingAction =
    !collapsed && !navTourActive ? trailingAction : undefined;
  const activeExpansion =
    !collapsed && !navTourActive ? (expansion ?? null) : null;
  const pillGapClass = pillTrailingAction ? "gap-[12px]" : undefined;
  const rowAside = !collapsed && !navTourActive ? aside : undefined;
  const rowBeneath = !collapsed && !navTourActive ? beneath : undefined;
  /* The pill keeps hugging its label and the aside follows it at the stack's
     own gap, so the two read as one cluster rather than a pill and a button
     at opposite ends of the rail. */
  const withAside = (row: ReactNode): ReactNode =>
    rowAside ? (
      <div className={cn("flex items-center", SIDEBAR_STACK_GAP)}>
        {row}
        {rowAside}
      </div>
    ) : (
      row
    );

  const avatarImage =
    uploadedAvatarUrl !== null ? (
      <span
        aria-hidden="true"
        className="pointer-events-none flex shrink-0 items-center justify-center"
        style={{ width: DISC_SIZE, height: DISC_SIZE }}
      >
        <img
          src={uploadedAvatarUrl}
          alt=""
          width={DISC_SIZE}
          height={DISC_SIZE}
          className="rounded-full object-cover"
          style={{ width: DISC_SIZE, height: DISC_SIZE }}
        />
      </span>
    ) : null;

  /* The Brain in a disc-sized slot rather than as the row's own 14px icon, so
     the plain pill's label starts where the tinted one's does. */
  const brainSlot = (
    <span
      aria-hidden="true"
      className="pointer-events-none flex shrink-0 items-center justify-center"
      style={{ width: DISC_SIZE, height: DISC_SIZE }}
    >
      <Brain
        className="h-3.5 w-3.5"
        style={{
          color: active ? "var(--content-default)" : "var(--content-tertiary)",
        }}
      />
    </span>
  );

  /* Saved traits outrank an uploaded image, as they do in ChatAvatar; an
     image displaces only the default creature. Decided from the traits, not
     from the accent: an image carries an accent of its own now, and that
     colour washes the New Chat row above without making the row a character. */
  const wearsImage = customImageUrl !== null && !traits;

  if (!hex || wearsImage) {
    // No character to draw (an uploaded image, or an avatar not loaded yet):
    // a plain-toned row with the tinted row's geometry. The uploaded image
    // fills the disc; the Brain icon centres in a slot the disc's size.
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
          (activeExpansion ??
          withAside(
            <PanelItem
              shape="pill"
              leadingSlot={avatarImage ?? brainSlot}
              label={label}
              active={active}
              onSelect={onSelect}
              trailingAction={pillTrailingAction}
              className={cn(DISC_PILL_CLASSES, pillGapClass)}
              style={DISC_PILL_STYLE}
              data-tour-id="assistant-page"
            />,
          ))
        )}
        {rowBeneath}
        {newConversationRow}
      </div>
    );
  }

  // The ink on the avatar colour (the collapsed tile, the flooded pill, the
  // Brain on the disc): white on every avatar colour except the light one
  // (yellow), where white would wash out. The avatar surfaces' own rule, so
  // the cluster agrees with the section toggle beside it.
  const fg = toneForBg(hex).fg;

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

  /* The assistant's own colour as a wash under the pill, the same 15% mix
     the New Chat row and the pinned apps wear, so the column's tinted rows
     agree and the disc is the pill's one solid surface. Declared as the
     pill's tint properties rather than written over `PanelItem`'s classes;
     hover and current-page raise the wash a step. While the tour owns the
     nav the colour drains away entirely: nothing is declared, so the pill
     falls back to its plain surface and the tour's flood is the only colour
     on screen. */
  const tintStyle: CustomPropertyStyle = {
    ...(!navTourActive && hex ? panelItemWashStyle(hex) : undefined),
    ...DISC_PILL_STYLE,
    "--pill-flood-fg": fg,
  };
  const floods = !navTourActive && Boolean(hex);

  /* The eyes, holding still in the pill's leading disc: centred in the same
     chip-width box the section icons use, and that box centred in the disc,
     so the eyes sit on the axis the glyphs below centre on. They blink where
     they sit and go nowhere else, which is what keeps them off the name
     beside them. */
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

  /* The disc: the pill's one solid surface, painted in the assistant's
     colour with the eyes on it (Figma 8300:167394). While the tour owns the
     nav it drains with the wash and the Brain stands in the slot on nothing,
     as the plain pill's does. */
  const eyesDisc = (
    <span
      aria-hidden="true"
      className="pointer-events-none flex shrink-0 items-center justify-center rounded-full"
      style={{
        width: DISC_SIZE,
        height: DISC_SIZE,
        backgroundColor: navTourActive ? undefined : hex,
        color: fg,
      }}
    >
      {/* Inside the disc's slot rather than a sibling of the pill's content,
          which `PanelItem` gives no slot for; `absolute` places it against
          the pill (the nearest positioned box), not the disc. */}
      {floods ? (
        <span
          aria-hidden="true"
          data-slot="assistant-pill-flood"
          className={FLOOD_CLASSES}
          style={{ backgroundColor: hex }}
        />
      ) : null}
      {eyesSlot}
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
        leadingSlot={eyesDisc}
        label={label}
        active={active}
        onSelect={onSelect}
        trailingAction={pillTrailingAction}
        className={cn(
          DISC_PILL_CLASSES,
          floods && FLOODED_PILL_CLASSES,
          pillGapClass,
        )}
        data-tour-id="assistant-page"
      />
    </span>
  );

  return (
    <div className={cn("flex flex-col", SIDEBAR_STACK_GAP)}>
      {activeExpansion ?? withAside(assistantRow)}
      {rowBeneath}
      {newConversationRow}
    </div>
  );
}
