/**
 * The assistant overview — the landing page of the About Assistant
 * section. A bento mosaic on a surface lightly tinted with the avatar's
 * color: the avatar and a typewritten "Hi, I'm {name}" greeting (with
 * inline rename) sit in the center cell, surrounded by organically-rounded
 * drill-down cards (Personality, Schedules, Skills, Plugins, Workspace,
 * Contacts, Channels — the replacement for the old tab bar), each carrying
 * one glanceable stat. On narrow or short viewports the mosaic collapses
 * to a stacked avatar + card grid.
 */

import { useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  FolderOpen,
  Puzzle,
  Radio,
  Sparkles,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useRef, useState, type CSSProperties } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Link } from "react-router";

import { Card, Tag, toast } from "@vellumai/design-library";

import { AvatarManagementModal } from "@/components/avatar/avatar-management-modal";
import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { PageShell } from "@/components/page-shell";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useElementSize } from "@/hooks/use-element-size";
import { useSupportsPluginsSurface } from "@/lib/backwards-compat/plugins-surface";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { contrastForeground } from "@/utils/avatar-tone";

import { applyRename } from "../identity-actions/apply-rename";
import {
  assistantIdentityDetailsQueryKey,
  useAssistantIdentityDetails,
} from "../use-assistant-identity-details";
import {
  useIdentitySectionStats,
  type IdentitySectionStat,
} from "../use-identity-section-stats";
import {
  AmoebaPeekTab,
  amoebaTargetForCard,
  type AmoebaFacing,
  type AmoebaTarget,
} from "./amoeba-avatar";
import { AssistantNameEditor } from "./assistant-name-editor";
import { resolveAvatarHex } from "./assistant-stage";
import { buildIdentitySections, type IdentitySection } from "./identity-sections";
import { PersonalityRadar } from "./personality-radar";

const SECTION_ICONS: Record<string, LucideIcon> = {
  personality: Sparkles,
  schedules: CalendarClock,
  skills: Zap,
  plugins: Puzzle,
  workspace: FolderOpen,
  contacts: Users,
  channels: Radio,
};

/**
 * Hand-varied corner radii per card so the mosaic reads as placed by hand
 * rather than stamped from one template. The two feature cards
 * (Personality, Schedules) share one uniform radius so the top-row trio
 * reads symmetric.
 */
const SECTION_RADII: Record<string, string> = {
  personality: "rounded-3xl",
  schedules: "rounded-3xl",
  skills: "rounded-[1.25rem_2.75rem_1.25rem_2.5rem]",
  channels: "rounded-[2.25rem_1rem_2.5rem_1.25rem]",
  contacts: "rounded-[1rem_2.5rem_1.25rem_2.75rem]",
  plugins: "rounded-[2.5rem_1.25rem_2.75rem_1rem]",
  workspace: "rounded-[1.25rem_2.5rem_1rem_2.5rem]",
};

/** Below these bento dimensions the mosaic collapses to the stacked layout. */
const BENTO_MIN_W = 720;
const BENTO_MIN_H = 480;

/** Sections rendered as compact mini cards in the bottom strip. */
const MINI_SECTION_KEYS = [
  "skills",
  "plugins",
  "workspace",
  "contacts",
  "channels",
];

/**
 * In-character center-text lines while the avatar is off hugging a card —
 * the greeting becomes his commentary on whatever you're pointing at.
 */
const CARD_HOVER_LINES: Record<string, string> = {
  personality: "Go ahead — tweak my soul",
  skills: "Everything I know how to do",
  plugins: "My add-ons — extra superpowers",
  schedules: "What I do on repeat",
  workspace: "All the files that power me",
  contacts: "The people I know and trust",
  channels: "All the places you can reach me",
};


/** "14 Jul, 9:00 am" — compact next-fire time for the schedules preview. */
function formatNextRun(nextRunAt: number): string {
  if (!Number.isFinite(nextRunAt) || nextRunAt <= 0) {
    return "—";
  }
  return new Date(nextRunAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const AVATAR_MAX_SIZE = 280;
const AVATAR_MIN_SIZE = 140;

/**
 * Bento hero avatar: very large, bottom-anchored behind the cards. Sized
 * as a fraction of the bento WIDTH so it scales with the window instead
 * of swallowing short-but-wide layouts (height only caps it, via the
 * greeting headroom).
 */
const HERO_AVATAR_WIDTH_FRACTION = 0.44;
const HERO_AVATAR_MAX_SIZE = 1118;
const HERO_AVATAR_MIN_SIZE = 300;
/** Fraction of the hero avatar clipped below the page's bottom edge. */
const HERO_AVATAR_CUT_FRACTION = 0.09;

/**
 * How much of the avatar's color is mixed into the page surface, the card
 * surfaces, and the cards' hover fill. Mixing into theme tokens (rather
 * than hardcoding a lightened hex) keeps the tint working across
 * light/dark/velvet. Cards get a lighter wash than the page so they still
 * read as raised tiles without the clinical white-on-tint contrast.
 */
const BG_TINT_PERCENT = 14;
const CARD_TINT_PERCENT = 5;
const HOVER_TINT_PERCENT = 22;

interface IdentityOverviewProps {
  assistantId: string;
  onOpenThread?: (message: string) => void;
}

export function IdentityOverview({
  assistantId,
  onOpenThread,
}: IdentityOverviewProps) {
  const queryClient = useQueryClient();
  const {
    components,
    traits,
    customImageUrl,
    isLoading: isAvatarLoading,
    invalidate: invalidateAvatar,
  } = useAssistantAvatar(assistantId);
  const identityQuery = useAssistantIdentityDetails(assistantId);
  const supportsPlugins = useSupportsPluginsSurface();
  const showChannels = useAssistantFeatureFlagStore.use.channelTrustFloors();
  const stats = useIdentitySectionStats(assistantId, {
    supportsPlugins,
    showChannels,
  });

  const [modalOpen, setModalOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);

  const handleRename = useCallback(
    (newName: string) => {
      setIsRenaming(true);
      void applyRename(assistantId, newName).then((ok) => {
        setIsRenaming(false);
        if (ok) {
          void queryClient.invalidateQueries({
            queryKey: assistantIdentityDetailsQueryKey(assistantId),
          });
          const { version, setIdentity } =
            useAssistantIdentityStore.getState();
          setIdentity(newName, version);
          toast.success(`Say hi to ${newName}!`);
        } else {
          toast.error("The rename didn't go through. Please try again.");
        }
      });
    },
    [assistantId, queryClient],
  );

  const handleAvatarChange = useCallback(() => {
    invalidateAvatar();
  }, [invalidateAvatar]);

  const handleGenerateWithAI = useCallback(() => {
    onOpenThread?.("I'd like to create a custom AI-generated avatar.");
  }, [onOpenThread]);

  const sections = buildIdentitySections({ supportsPlugins, showChannels });
  const isLoading = isAvatarLoading || identityQuery.isLoading;
  const avatarHex = resolveAvatarHex(components, traits);

  return (
    <PageShell
      style={
        avatarHex
          ? {
              backgroundColor: `color-mix(in srgb, ${avatarHex} ${BG_TINT_PERCENT}%, var(--surface-overlay))`,
            }
          : undefined
      }
    >
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div
            className="h-6 w-6 animate-spin rounded-full border-2"
            style={{
              borderColor: "var(--border-base)",
              borderTopColor: "var(--content-tertiary)",
            }}
          />
        </div>
      ) : (
        <OverviewBento
          components={components}
          traits={traits}
          customImageUrl={customImageUrl}
          name={identityQuery.data?.identity?.name || "Assistant"}
          sections={sections}
          stats={stats}
          avatarHex={avatarHex}
          isRenaming={isRenaming}
          onOpenAvatarModal={() => setModalOpen(true)}
        />
      )}

      <AvatarManagementModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        assistantId={assistantId}
        components={components}
        traits={traits}
        customImageUrl={customImageUrl}
        onSaveCharacter={handleAvatarChange}
        onUploadImage={handleAvatarChange}
        onGenerateWithAI={onOpenThread ? handleGenerateWithAI : undefined}
        assistantName={identityQuery.data?.identity?.name || "Assistant"}
        onRenameSubmit={handleRename}
        isRenaming={isRenaming}
      />
    </PageShell>
  );
}

function SectionCard({
  section,
  stat,
  gridArea,
  cardStyle,
  hoverFill,
  mini,
  flooded = false,
  floodOrigin,
  linkRef,
  onHoverChange,
}: {
  section: IdentitySection;
  stat: IdentitySectionStat | undefined;
  /** Named bento cell; omitted in the stacked layout's plain grid. */
  gridArea?: string;
  /** Extra card-root styles (e.g. self-sizing within a taller area). */
  cardStyle?: CSSProperties;
  /** Tint the card itself on hover — off when the amoeba avatar reacts instead. */
  hoverFill: boolean;
  /** Compact one-row variant for the bottom-strip sections. */
  mini?: boolean;
  /** The avatar has poured itself over this card — fill it with the
   *  avatar color and flip the content to the contrast tone. */
  flooded?: boolean;
  /** Where the flood enters, in percent of the card box. */
  floodOrigin?: { x: number; y: number };
  linkRef?: (el: HTMLAnchorElement | null) => void;
  onHoverChange?: (hovering: boolean) => void;
}) {
  const Icon = SECTION_ICONS[section.key] ?? Sparkles;

  // Keep the last origin while draining so the water recedes back to
  // where it came from. Render-time state adjustment (not an effect).
  const [lastOrigin, setLastOrigin] = useState({ x: 50, y: 100 });
  if (floodOrigin && floodOrigin !== lastOrigin) {
    setLastOrigin(floodOrigin);
  }

  const fg = flooded
    ? "text-[var(--card-flood-fg)]"
    : "text-[var(--content-default)]";
  const fgStrong = flooded
    ? "text-[var(--card-flood-fg)]"
    : "text-[var(--content-strong)]";
  const fgMuted = flooded
    ? "text-[var(--card-flood-fg)] opacity-75"
    : "text-[var(--content-secondary)]";

  // The avatar-color "water" covering the card, expanding from the point
  // the avatar enters (the tab's anchor on the facing edge).
  const floodOverlay = (
    <motion.span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{ backgroundColor: "var(--card-accent)" }}
      initial={false}
      animate={{
        clipPath: flooded
          ? `circle(141% at ${lastOrigin.x}% ${lastOrigin.y}%)`
          : `circle(0% at ${lastOrigin.x}% ${lastOrigin.y}%)`,
      }}
      transition={
        flooded
          ? { duration: 0.5, ease: "easeOut" }
          : { duration: 0.35, ease: "easeIn" }
      }
    />
  );

  if (mini) {
    const miniStat =
      stat?.value !== undefined
        ? `${stat.value} ${stat.label}`
        : stat?.chips && stat.chips.length > 0
          ? stat.chips.join(" · ")
          : stat?.text;
    // Bottom-strip tile per Figma (New-App 6944-89405): left-aligned,
    // 12px radius, 40px icon slot in the secondary tone, 16px title over
    // an 11px tertiary stat.
    return (
      <Card.Root
        asChild
        elevated
        clipContents
        className="rounded-[12px] bg-[var(--card-bg)]"
      >
        <Link
          to={section.to}
          ref={linkRef}
          onMouseEnter={() => onHoverChange?.(true)}
          onMouseLeave={() => onHoverChange?.(false)}
          className={`relative flex h-full flex-1 cursor-pointer items-center gap-2 px-4 py-2.5 transition-all duration-150 active:scale-[0.98] ${
            hoverFill ? "hover:bg-[var(--card-hover)]" : ""
          }`}
        >
          {floodOverlay}
          <span className="relative flex h-10 w-10 shrink-0 items-center justify-center">
            <Icon
              className={`h-5 w-5 transition-colors duration-300 ${fgMuted}`}
              aria-hidden
            />
          </span>
          <span className="relative flex min-w-0 flex-col gap-1">
            <span
              className={`truncate text-title-small leading-normal transition-colors duration-300 ${fgStrong}`}
            >
              {section.label}
            </span>
            {miniStat && (
              <span
                className={`truncate text-[11px] leading-normal font-medium transition-colors duration-300 ${
                  flooded
                    ? "text-[var(--card-flood-fg)] opacity-75"
                    : "text-[var(--content-tertiary)]"
                }`}
              >
                {miniStat}
              </span>
            )}
          </span>
        </Link>
      </Card.Root>
    );
  }

  // The feature cards (Personality, Schedules) wear a stronger wash of the
  // avatar color — lighter than the avatar itself, darker than the page
  // tint (Figma: New-App 6944-89250). `--card-feature-bg` collapses to the
  // plain card surface when there's no character color (custom image), so
  // they flow with the regular theme. A class (not inline style) so the
  // hover fill can still win.
  const isFeatureCard =
    section.key === "personality" || section.key === "schedules";

  return (
    // The feature cards float flat on the page — no border, no shadow;
    // the other tiles keep the standard raised card chrome.
    <Card.Root
      asChild
      bordered={!isFeatureCard}
      elevated={!isFeatureCard}
      className={`${SECTION_RADII[section.key] ?? ""} ${
        isFeatureCard
          ? "bg-[var(--card-feature-bg,var(--card-bg))]"
          : "bg-[var(--card-bg)]"
      }`}
      style={{
        ...(gridArea ? { gridArea } : {}),
        ...cardStyle,
      }}
    >
      {/* Corner-anchored tile: identity cluster pinned top-left, the stat
          pinned bottom-left as a display-size numeral. Anchoring (rather
          than centering) turns the card's empty area into intentional
          negative space. */}
      <Link
        to={section.to}
        ref={linkRef}
        onMouseEnter={() => onHoverChange?.(true)}
        onMouseLeave={() => onHoverChange?.(false)}
        className={`relative flex h-full w-full cursor-pointer flex-col justify-between gap-3 overflow-hidden p-5 text-left transition-all duration-150 active:scale-[0.98] ${
          hoverFill ? "hover:bg-[var(--card-hover)]" : ""
        }`}
      >
        {floodOverlay}
        {/* The Personality card fills with the radar of the persisted
            slider values; bento only (`gridArea`). The blob reads the
            `--card-accent` var, so it flips to the contrast tone while
            flooded along with the grid/labels (currentColor). */}
        {gridArea && stat?.radar && (
          <span
            className={`absolute inset-x-5 top-14 bottom-4 flex items-center justify-center transition-colors duration-300 ${
              flooded
                ? "text-[var(--card-flood-fg)]"
                : "text-[var(--content-secondary)]"
            }`}
            style={
              flooded
                ? ({ "--card-accent": "var(--card-flood-fg)" } as CSSProperties)
                : undefined
            }
          >
            <PersonalityRadar values={stat.radar} className="h-auto w-full" />
          </span>
        )}
        {isFeatureCard ? (
          // Compact header (Figma 6944-89250): icon beside the title, no
          // description — the content is the card's whole story.
          <span className="relative flex items-center gap-2">
            <Icon
              className={`h-5 w-5 transition-colors duration-300 ${fg}`}
              aria-hidden
            />
            <span
              className={`text-body-medium-default transition-colors duration-300 ${fg}`}
            >
              {section.label}
            </span>
          </span>
        ) : (
          <span className="relative flex flex-col items-start gap-1.5">
            <Icon
              className={`h-6 w-6 transition-colors duration-300 ${fg}`}
              aria-hidden
            />
            <span className="flex flex-col">
              <span
                className={`text-body-medium-default transition-colors duration-300 ${fg}`}
              >
                {section.label}
              </span>
              <span
                className={`text-[13px] transition-colors duration-300 ${fgMuted}`}
              >
                {section.description}
              </span>
            </span>
          </span>
        )}
        {/* The tall Schedules card previews the upcoming enabled
            schedules; bento only (`gridArea`), where there's room. */}
        {gridArea && stat?.schedules && stat.schedules.items.length > 0 && (
          <span className="relative flex min-h-0 flex-1 flex-col justify-start gap-2 overflow-hidden py-2">
            {stat.schedules.items.map((schedule) => (
              <span
                key={schedule.id}
                className="flex flex-col gap-0.5 rounded-xl px-3 py-2 transition-colors duration-300"
                style={{
                  // A content-tinted wash (not a surface token) so the tile
                  // visibly lifts off the card in dark themes too.
                  backgroundColor: flooded
                    ? "color-mix(in srgb, var(--card-flood-fg) 12%, transparent)"
                    : "color-mix(in srgb, var(--content-default) 5%, transparent)",
                }}
              >
                <span
                  className={`truncate text-[13px] font-medium transition-colors duration-300 ${fg}`}
                >
                  {schedule.name}
                </span>
                <span
                  className={`truncate text-[12px] transition-colors duration-300 ${fgMuted}`}
                >
                  {schedule.cadence} · next {formatNextRun(schedule.nextRunAt)}
                </span>
              </span>
            ))}
            {stat.schedules.more > 0 && (
              <span
                className={`text-[12px] font-medium transition-colors duration-300 ${fgMuted}`}
              >
                View {stat.schedules.more} more…
              </span>
            )}
          </span>
        )}
        {stat?.value !== undefined ? (
          <span className="relative flex flex-col leading-none">
            <span
              className={`text-[3.25rem] transition-colors duration-300 max-lg:text-[2.5rem] ${fgStrong}`}
              style={{ fontFamily: "var(--font-serif)" }}
            >
              {stat.value}
            </span>
            <span
              className={`mt-1 text-[13px] transition-colors duration-300 ${fgMuted}`}
            >
              {stat.label}
            </span>
          </span>
        ) : stat?.chips && stat.chips.length > 0 ? (
          <span className="relative flex flex-wrap items-center gap-1">
            {stat.chips.map((chip) => (
              <Tag key={chip}>{chip}</Tag>
            ))}
          </span>
        ) : stat?.text ? (
          <span
            className={`relative text-[14px] font-medium italic transition-colors duration-300 ${fg}`}
          >
            {stat.text}
          </span>
        ) : null}
      </Link>
    </Card.Root>
  );
}

/** Greeting + avatar for the stacked (small-viewport) layout. */
function CenterCell({
  components,
  traits,
  customImageUrl,
  name,
  avatarSize,
  isRenaming,
  onEdit,
}: {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  name: string;
  avatarSize: number;
  isRenaming: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="relative z-[1] flex flex-col items-center justify-center gap-5">
      <AssistantNameEditor name={name} isRenaming={isRenaming} />
      <button
        type="button"
        aria-label="Update avatar and name"
        title="Update avatar and name"
        onClick={onEdit}
        className="avatar-edit-cursor outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]"
      >
        {customImageUrl && !traits ? (
          // Custom image: a plain static circle — no entrance or bounce.
          <img
            src={customImageUrl}
            alt=""
            width={avatarSize}
            height={avatarSize}
            className="rounded-full object-cover"
            style={{ width: avatarSize, height: avatarSize }}
          />
        ) : (
          <ChatAvatar
            components={components}
            traits={traits}
            customImageUrl={customImageUrl}
            size={avatarSize}
            interactive
          />
        )}
      </button>
    </div>
  );
}

/**
 * The bento mosaic: Personality owns the full left column, Skills and
 * Plugins run across the top, Schedules owns the right column below
 * Plugins, the avatar + greeting take the wide center, and the
 * low-priority sections (Channels, Contacts, Workspace) fill a slim
 * full-width row along the bottom of the center. It also orchestrates
 * the avatar's card-hover act: the resting avatar disappears, the
 * hovered card floods with the avatar color, and the peek tab surfaces
 * on the card's center-facing edge.
 */
function OverviewBento({
  components,
  traits,
  customImageUrl,
  name,
  sections,
  stats,
  avatarHex,
  isRenaming,
  onOpenAvatarModal,
}: {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  name: string;
  sections: IdentitySection[];
  stats: Record<string, IdentitySectionStat | undefined>;
  avatarHex: string | null;
  isRenaming: boolean;
  onOpenAvatarModal: () => void;
}) {
  const { ref, size } = useElementSize();
  const reduce = useReducedMotion();
  const useBento = size.w >= BENTO_MIN_W && size.h >= BENTO_MIN_H;

  const avatarSize = Math.round(
    Math.min(
      AVATAR_MAX_SIZE,
      Math.max(AVATAR_MIN_SIZE, Math.min(size.w, size.h) * 0.32),
    ),
  );

  // Character avatars get the theatrics — the giant bottom-anchored hero,
  // the color tints, the amoeba hover act. A custom image (or no avatar)
  // stays calm: a static circle under the greeting on regular theme colors.
  const hasCharacter = Boolean(avatarHex && components && traits);

  // The amoeba avatar needs a color + eye art to morph with; custom-image
  // and reduced-motion users keep the static avatar and card hover fills.
  const morphing = useBento && !reduce && hasCharacter;

  const containerEl = useRef<HTMLDivElement | null>(null);
  const cardEls = useRef<Record<string, HTMLElement | null>>({});
  const [hugged, setHugged] = useState<{
    key: string;
    target: AmoebaTarget;
    /** Flood origin, in percent of the hovered card's box. */
    origin: { x: number; y: number };
  } | null>(null);

  const setContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      containerEl.current = el;
      ref(el);
    },
    [ref],
  );

  const handleCardHover = useCallback(
    (key: string, hovering: boolean) => {
      if (!morphing) {
        return;
      }
      if (!hovering) {
        setHugged(null);
        return;
      }
      const container = containerEl.current;
      const el = cardEls.current[key];
      if (!container || !el) {
        return;
      }
      const cr = container.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const rect = {
        left: r.left - cr.left,
        top: r.top - cr.top,
        width: r.width,
        height: r.height,
      };
      // The eyes peek from the card edge that faces the page center —
      // whichever axis the card sits furthest out on wins.
      const dx = (rect.left + rect.width / 2 - cr.width / 2) / (cr.width / 2);
      const dy = (rect.top + rect.height / 2 - cr.height / 2) / (cr.height / 2);
      const facing: AmoebaFacing =
        Math.abs(dx) > Math.abs(dy)
          ? dx < 0
            ? "right"
            : "left"
          : dy < 0
            ? "bottom"
            : "top";
      const target = amoebaTargetForCard(rect, facing, {
        x: cr.width / 2,
        y: cr.height / 2,
      });
      setHugged({
        key,
        target,
        origin: {
          x: (target.peek.x / rect.width) * 100,
          y: (target.peek.y / rect.height) * 100,
        },
      });
    },
    [morphing],
  );

  // Guard against a stale hug when the morph gets disabled mid-hover
  // (e.g. a resize into the stacked layout).
  const activeHug = morphing ? hugged : null;

  // While the avatar is off hugging a card, the center text becomes his
  // commentary on it.
  const greetingOverride = activeHug
    ? (CARD_HOVER_LINES[activeHug.key] ?? null)
    : null;

  // Without a character color (custom image / not loaded) every surface
  // falls back to the regular theme tokens — no forced white/black card
  // faces, no accent wash — so the page reads like the rest of the app.
  const tintStyle = {
    "--card-bg": avatarHex
      ? `color-mix(in srgb, ${avatarHex} var(--card-tint-pct, ${CARD_TINT_PERCENT}%), var(--card-surface, var(--surface-lift)))`
      : "var(--surface-lift)",
    "--card-feature-bg": avatarHex
      ? "color-mix(in srgb, var(--card-accent) 28%, var(--card-surface, var(--surface-lift)))"
      : "var(--surface-lift)",
    "--card-hover": avatarHex
      ? `color-mix(in srgb, ${avatarHex} ${HOVER_TINT_PERCENT}%, var(--card-surface, var(--surface-lift)))`
      : "var(--surface-hover)",
    "--card-accent": avatarHex ?? "var(--content-default)",
    "--card-flood-fg": avatarHex
      ? contrastForeground(avatarHex)
      : "var(--content-default)",
  } as CSSProperties;

  // The avatar is a background element positioned against the full page —
  // cards overlap it freely; cap only so his head stays inside the frame.
  const heroHeadroomCap = (size.h - 8) / (1 - HERO_AVATAR_CUT_FRACTION);
  const heroAvatarSize = Math.round(
    Math.min(
      HERO_AVATAR_MAX_SIZE,
      heroHeadroomCap,
      Math.max(HERO_AVATAR_MIN_SIZE, size.w * HERO_AVATAR_WIDTH_FRACTION),
    ),
  );
  const heroCutPx = Math.round(heroAvatarSize * HERO_AVATAR_CUT_FRACTION);

  const centerCell = (
    <CenterCell
      components={components}
      traits={traits}
      customImageUrl={customImageUrl}
      name={name}
      avatarSize={avatarSize}
      isRenaming={isRenaming}
      onEdit={onOpenAvatarModal}
    />
  );

  if (!useBento) {
    return (
      <div
        ref={setContainerRef}
        className="identity-bento flex min-h-0 flex-1 flex-col items-center gap-6 overflow-y-auto px-2 py-4"
        style={tintStyle}
      >
        {centerCell}
        <div className="grid w-full max-w-md shrink-0 grid-cols-2 gap-3">
          {sections.map((section) => (
            <SectionCard
              key={section.key}
              section={section}
              stat={stats[section.key]}
              hoverFill
            />
          ))}
        </div>
      </div>
    );
  }

  // Priority layout: Personality owns the left column (radar centered in
  // it) and Schedules the right, both the same height above the strip,
  // and everything else (Skills, Plugins, Workspace, Contacts, Channels)
  // runs as compact mini cards in a full-width bottom strip.
  const mainSections = sections.filter((s) => !MINI_SECTION_KEYS.includes(s.key));
  const miniSections = sections.filter((s) => MINI_SECTION_KEYS.includes(s.key));

  // Top row is a centered trio — Personality, the greeting, Schedules —
  // and the rows below stay open so the page-anchored avatar shows
  // through behind everything.
  // Schedules' AREA runs a row deeper than Personality, but the card
  // self-sizes from the top with Personality's row height as its minimum
  // — so the two match until the schedule tiles (3 max) need more room.
  const BENTO_ROWS = [1.15, 1, 0.45, 0.3];
  const BENTO_GAP_PX = 12;
  const rowUnit =
    (size.h - (BENTO_ROWS.length - 1) * BENTO_GAP_PX) /
    BENTO_ROWS.reduce((a, b) => a + b, 0);
  const personalityRowHeight = Math.round(rowUnit * BENTO_ROWS[0]!);

  // Character avatars float behind the open middle rows; a custom image
  // gets its own centered cell right under the greeting instead.
  const gridTemplateAreas = (
    hasCharacter
      ? [
          `"personality greeting greeting greeting schedules"`,
          `". . . . schedules"`,
          `". . . . ."`,
          `"smalls smalls smalls smalls smalls"`,
        ]
      : [
          `"personality greeting greeting greeting schedules"`,
          `". avatar avatar avatar schedules"`,
          `". avatar avatar avatar ."`,
          `"smalls smalls smalls smalls smalls"`,
        ]
  ).join(" ");

  const cardProps = (section: IdentitySection) => ({
    section,
    stat: stats[section.key],
    hoverFill: !morphing,
    flooded: activeHug?.key === section.key,
    floodOrigin: activeHug?.key === section.key ? activeHug.origin : undefined,
    linkRef: (el: HTMLAnchorElement | null) => {
      cardEls.current[section.key] = el;
    },
    onHoverChange: (hovering: boolean) =>
      handleCardHover(section.key, hovering),
  });

  return (
    <div
      ref={setContainerRef}
      className="identity-bento relative grid min-h-0 flex-1 gap-3 overflow-hidden"
      style={{
        ...tintStyle,
        gridTemplateColumns: "1.55fr 1fr 1fr 1fr 1.55fr",
        gridTemplateRows: BENTO_ROWS.map((r) => `${r}fr`).join(" "),
        gridTemplateAreas,
      }}
    >
      {hasCharacter ? (
        /* Hero avatar: very large, bottom-anchored so its chin dips just
           past the page edge, sitting behind the cards (rendered before
           them, same z-plane). */
        <motion.div
          className="pointer-events-none absolute left-1/2 z-0"
          style={{
            width: heroAvatarSize,
            height: heroAvatarSize,
            bottom: -heroCutPx,
            x: "-50%",
          }}
          initial={false}
          animate={
            activeHug ? { scale: 0.4, opacity: 0 } : { scale: 1, opacity: 1 }
          }
          transition={
            activeHug
              ? { duration: 0.15 }
              : { delay: 0.25, type: "spring", stiffness: 210, damping: 18 }
          }
        >
          <div
            role="button"
            tabIndex={0}
            aria-label="Update avatar and name"
            title="Update avatar and name"
            onClick={onOpenAvatarModal}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpenAvatarModal();
              }
            }}
            className="avatar-edit-cursor pointer-events-auto relative h-full w-full outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]"
          >
            <ChatAvatar
              components={components}
              traits={traits}
              customImageUrl={customImageUrl}
              size={heroAvatarSize}
              interactive
            />
          </div>
        </motion.div>
      ) : (
        /* Custom image (or no avatar): a calm, static circle centered
           under the greeting — no entrance, no hover act. Still the edit
           trigger. */
        <div
          className="relative z-[1] flex items-start justify-center"
          style={{ gridArea: "avatar" }}
        >
          <button
            type="button"
            aria-label="Update avatar and name"
            title="Update avatar and name"
            onClick={onOpenAvatarModal}
            className="avatar-edit-cursor rounded-full outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]"
          >
            {customImageUrl ? (
              <img
                src={customImageUrl}
                alt=""
                width={avatarSize}
                height={avatarSize}
                className="rounded-full object-cover"
                style={{ width: avatarSize, height: avatarSize }}
              />
            ) : (
              <ChatAvatar
                components={components}
                traits={traits}
                customImageUrl={null}
                size={avatarSize}
              />
            )}
          </button>
        </div>
      )}
      {/* Greeting: the middle of the top-row trio, center-aligned with the
          two feature cards. Its own layer (not inside the fading hero) so
          the name never blinks out while the avatar dives into a card —
          instead it becomes his commentary on the hovered card. */}
      <div
        className="relative z-[1] flex items-center justify-center"
        style={{ gridArea: "greeting" }}
      >
        <AssistantNameEditor
          name={name}
          isRenaming={isRenaming}
          overrideText={greetingOverride}
        />
      </div>
      {morphing && avatarHex && components && traits && (
        <AmoebaPeekTab
          hex={avatarHex}
          components={components}
          traits={traits}
          target={activeHug?.target ?? null}
        />
      )}
      {mainSections.map((section) => (
        <SectionCard
          key={section.key}
          {...cardProps(section)}
          gridArea={section.key}
          cardStyle={
            section.key === "schedules"
              ? {
                  // The card's `h-full` class resolves against the full
                  // two-row grid area — inline `auto` restores content
                  // sizing so `alignSelf: start` + the min-height (one
                  // personality-row) actually govern the height.
                  alignSelf: "start",
                  height: "auto",
                  minHeight: personalityRowHeight,
                }
              : undefined
          }
        />
      ))}
      <div
        className="flex min-h-0 items-stretch gap-3"
        style={{ gridArea: "smalls" }}
      >
        {miniSections.map((section) => (
          <SectionCard key={section.key} {...cardProps(section)} mini />
        ))}
      </div>
    </div>
  );
}
