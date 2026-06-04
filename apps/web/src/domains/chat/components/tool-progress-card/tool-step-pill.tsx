/**
 * Button-based tool-call step pill matching Figma node `5010-103193`.
 *
 * A leading glyph (from `ICON_MAP`) + a truncating label + an optional
 * trailing `RiskBadge`. When an `onClick` is supplied the pill renders as a
 * real `<button>` (with hover / focus affordances); otherwise it renders a
 * non-interactive `<span>` with identical layout classes minus the
 * interactive styling, so static / no-action contexts don't get a dead
 * button.
 *
 * When both `onClick` and `onRiskBadgeClick` are provided, the pill renders
 * as a `<div>` with `role="button"` so the risk badge can render its own
 * `<button>` without nesting interactive elements (invalid per HTML spec).
 *
 * Props are intentionally PRIMITIVE (icon name + strings) rather than coupled
 * to `ToolCallCardStep`, so the pill is independently testable and reusable
 * outside the card pipeline.
 */

import type { KeyboardEvent } from "react";

import { Bolt } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { RiskBadge } from "@/domains/chat/components/risk-badge";
import type { IconName } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { ICON_MAP } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";

export interface ToolStepPillProps {
  iconName: IconName;
  label: string;
  riskLevel?: string;
  onClick?: () => void;
  /** Click handler for the risk badge. Opens the trust-rule editor. */
  onRiskBadgeClick?: () => void;
  tone?: "default" | "error";
  /**
   * Selected state — rendered when this pill's tool-detail drawer is open.
   * Mirrors the design-library outlined+active button (primary border, lifted
   * surface, primary-active text) so the open pill reads as the active source.
   */
  active?: boolean;
  /** Accessible label for the button. Defaults to `View details: ${label}`. */
  ariaLabel?: string;
}

/**
 * Shared layout classes applied to both the button and span variants.
 *
 * `leading-normal` is load-bearing: the label uses `truncate` (which sets
 * `overflow: hidden`), and the `body-small-default` line-height is tight
 * enough that descenders ("g", "p", "y") get clipped without extra leading.
 */
const BASE_CLASSES =
  "inline-flex min-w-0 max-w-full items-center gap-1 self-start rounded-full border px-[10px] py-[6px] text-left leading-normal";

/** Cursor / transition / focus-ring affordances when the pill is a button. */
const INTERACTIVE_BASE =
  "transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]";

export function ToolStepPill({
  iconName,
  label,
  riskLevel,
  onClick,
  onRiskBadgeClick,
  tone = "default",
  active = false,
  ariaLabel,
}: ToolStepPillProps) {
  // Active = a filled `--surface-active` background with the resting border /
  // text kept neutral (the colored border read poorly against the card). Active
  // overrides tone's background wholesale so we never emit conflicting
  // arbitrary-value classes — Tailwind resolves equal-specificity collisions by
  // stylesheet order, not class-attribute order.
  const colorClasses = active
    ? tone === "error"
      ? "border-[var(--border-base)] bg-[var(--surface-active)] text-[var(--system-negative-strong)]"
      : "border-[var(--border-base)] bg-[var(--surface-active)] text-[var(--content-default)]"
    : tone === "error"
      ? "border-[var(--system-negative-weak)] bg-[var(--system-negative-weak)] text-[var(--system-negative-strong)]"
      : "border-[var(--border-base)] bg-transparent text-[var(--content-default)]";

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
    // Active pills hover toward the stronger `surface-active`; idle pills lift
    // to `surface-base`. Kept as distinct whole classes so the active hover
    // doesn't fight the idle hover.
    const hoverClass = active
      ? "hover:bg-[var(--surface-active)]"
      : "hover:bg-[var(--surface-base)]";

    // When onRiskBadgeClick is also provided, use a <div role="button"> as the
    // outer wrapper so the RiskBadge can render its own <button> without
    // nesting interactive elements (invalid per HTML spec). The div handles
    // keyboard activation for the main action; the badge button stops event
    // propagation to keep the two actions independent.
    if (onRiskBadgeClick) {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      };
      return (
        <div
          role="button"
          tabIndex={0}
          data-testid="tool-step-pill"
          data-active={active ? "" : undefined}
          aria-pressed={active}
          aria-label={ariaLabel ?? `View details: ${label}`}
          onClick={onClick}
          onKeyDown={handleKeyDown}
          className={`${BASE_CLASSES} ${INTERACTIVE_BASE} ${hoverClass} ${colorClasses}`}
        >
          {labelContent}
          <RiskBadge level={riskLevel} onClick={onRiskBadgeClick} />
        </div>
      );
    }

    return (
      <button
        type="button"
        data-testid="tool-step-pill"
        data-active={active ? "" : undefined}
        aria-pressed={active}
        aria-label={ariaLabel ?? `View details: ${label}`}
        onClick={onClick}
        className={`${BASE_CLASSES} ${INTERACTIVE_BASE} ${hoverClass} ${colorClasses}`}
      >
        {labelContent}
        <RiskBadge level={riskLevel} />
      </button>
    );
  }

  return (
    <span
      data-testid="tool-step-pill"
      className={`${BASE_CLASSES} ${colorClasses}`}
    >
      {labelContent}
      <RiskBadge level={riskLevel} />
    </span>
  );
}
