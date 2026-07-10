/**
 * Button-based tool-call step pill matching Figma node `5010-103193`.
 *
 * A leading glyph (from `ICON_MAP`) + a truncating label. When an `onClick`
 * is supplied the pill renders as a real `<button>` (with hover / focus
 * affordances); otherwise it renders a non-interactive `<span>` with
 * identical layout classes minus the interactive styling, so static /
 * no-action contexts don't get a dead button.
 *
 * The tool call's risk level is NOT shown here — it lives in the tool-detail
 * drawer's "Reasoning" section (see `ToolDetailBody`), keeping the timeline
 * pills compact.
 *
 * Props are intentionally PRIMITIVE (icon name + strings) rather than coupled
 * to `ToolCallCardStep`, so the pill is independently testable and reusable
 * outside the card pipeline.
 */

import { useState } from "react";

import { Bolt } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import type { IconName } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { ICON_MAP } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";

/** Shared across both pill variants. */
interface ToolStepPillBaseProps {
  /** Truncating pill label. */
  label: string;
  tone?: "default" | "error";
  /** Accessible label for the pill. Defaults per-variant. */
  ariaLabel?: string;
}

/**
 * Default pill: a lucide glyph (from `ICON_MAP`) + label, optionally a button
 * (when `onClick` is set).
 */
export interface ToolStepPillToolProps extends ToolStepPillBaseProps {
  variant?: "tool";
  iconName: IconName;
  onClick?: () => void;
  /**
   * Selected state — rendered when this pill's tool-detail drawer is open.
   * Mirrors the design-library outlined+active button (primary border, lifted
   * surface, primary-active text) so the open pill reads as the active source.
   */
  active?: boolean;
}

/**
 * Web variant: the SAME pill chrome, but the leading glyph is the site favicon
 * (with a domain/label monogram fallback) and the whole pill is an anchor that
 * opens `url` in a new tab. Used for web-search result sources.
 */
export interface ToolStepPillWebProps extends ToolStepPillBaseProps {
  variant: "web";
  /** Destination opened in a new tab — the pill renders as an `<a>`. */
  url: string;
  /** Site favicon URL; falls back to a monogram from `domain`/`label` on miss. */
  faviconUrl?: string;
  /** Site domain — supplies the monogram fallback letter. */
  domain?: string;
}

export type ToolStepPillProps = ToolStepPillToolProps | ToolStepPillWebProps;

/**
 * Shared layout classes applied to both the button and span variants.
 *
 * `leading-normal` is load-bearing: the label uses `truncate` (which sets
 * `overflow: hidden`), and the `body-small-default` line-height is tight
 * enough that descenders ("g", "p", "y") get clipped without extra leading.
 */
const BASE_CLASSES =
  "inline-flex min-w-0 items-center gap-1 self-start rounded-full px-2 py-1 text-left leading-normal";

/** Cursor / transition / focus-ring affordances when the pill is a button. */
const INTERACTIVE_BASE =
  "transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]";

/** Resting / hover fill for a non-active pill in the given tone. */
function idleColorClasses(tone: "default" | "error"): string {
  return tone === "error"
    ? "bg-[var(--system-negative-weak)] text-[var(--system-negative-strong)]"
    : "bg-[var(--surface-overlay)] text-[var(--content-default)]";
}

/**
 * 14px favicon glyph occupying the same slot as the tool variant's lucide icon.
 * Falls back to a monogram (first letter of `domain`, else `label`) when the
 * favicon is absent or fails to load.
 */
function PillFavicon({
  faviconUrl,
  domain,
  label,
}: {
  faviconUrl?: string;
  domain?: string;
  label: string;
}) {
  const [failed, setFailed] = useState(false);
  const hasFavicon = Boolean(faviconUrl) && !failed;
  const source = domain && domain.length > 0 ? domain : label;
  const letter = source.charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)]"
    >
      {hasFavicon ? (
        <img
          src={faviconUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        // typography: off-scale — 10px monogram inside the 14px favicon slot
        <span className="text-[10px] font-medium leading-none text-[var(--content-tertiary)]">
          {letter}
        </span>
      )}
    </span>
  );
}

/** Anchor pill rendering for {@link ToolStepPillWebProps}. */
function WebStepPill({
  label,
  url,
  faviconUrl,
  domain,
  tone = "default",
  ariaLabel,
}: ToolStepPillWebProps) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="tool-step-pill"
      data-variant="web"
      aria-label={ariaLabel ?? `Open ${label}`}
      className={`${BASE_CLASSES} ${INTERACTIVE_BASE} max-w-[240px] no-underline hover:bg-[var(--surface-active)] ${idleColorClasses(tone)}`}
    >
      <PillFavicon faviconUrl={faviconUrl} domain={domain} label={label} />
      <Typography
        variant="body-small-default"
        className="min-w-0 truncate text-inherit leading-normal"
      >
        {label}
      </Typography>
    </a>
  );
}

export function ToolStepPill(props: ToolStepPillProps) {
  if (props.variant === "web") {
    return <WebStepPill {...props} />;
  }
  const {
    iconName,
    label,
    onClick,
    tone = "default",
    active = false,
    ariaLabel,
  } = props;
  // Active = a filled `--surface-active` background with the resting border /
  // text kept neutral (the colored border read poorly against the card). Active
  // overrides tone's background wholesale so we never emit conflicting
  // arbitrary-value classes — Tailwind resolves equal-specificity collisions by
  // stylesheet order, not class-attribute order.
  // No outline. Idle pills carry a `--surface-overlay` fill; the open pill
  // (its drawer showing) reads as active via the stronger `--surface-active`.
  const colorClasses = active
    ? tone === "error"
      ? "bg-[var(--surface-active)] text-[var(--system-negative-strong)]"
      : "bg-[var(--surface-active)] text-[var(--content-default)]"
    : tone === "error"
      ? "bg-[var(--system-negative-weak)] text-[var(--system-negative-strong)]"
      : "bg-[var(--surface-overlay)] text-[var(--content-default)]";

  const Glyph = ICON_MAP[iconName] ?? Bolt;
  const iconColor =
    tone === "error"
      ? "text-[var(--system-negative-strong)]"
      : "text-[var(--content-tertiary)]";

  const labelContent = (
    <>
      <Glyph
        aria-hidden="true"
        className={`h-3.5 w-3.5 shrink-0 ${iconColor}`}
      />
      <Typography
        variant="body-small-default"
        className="min-w-0 truncate text-inherit leading-normal"
      >
        {label}
      </Typography>
    </>
  );

  if (onClick) {
    // Both idle and active pills lift to `surface-active` on hover (idle from
    // `surface-overlay`, active already there).
    const hoverClass = "hover:bg-[var(--surface-active)]";

    return (
      <button
        type="button"
        data-testid="tool-step-pill"
        data-active={active ? "" : undefined}
        aria-pressed={active}
        aria-label={ariaLabel ?? `View details: ${label}`}
        onClick={onClick}
        className={`${BASE_CLASSES} ${INTERACTIVE_BASE} max-w-full ${hoverClass} ${colorClasses}`}
      >
        {labelContent}
      </button>
    );
  }

  return (
    <span
      data-testid="tool-step-pill"
      className={`${BASE_CLASSES} max-w-full ${colorClasses}`}
    >
      {labelContent}
    </span>
  );
}
