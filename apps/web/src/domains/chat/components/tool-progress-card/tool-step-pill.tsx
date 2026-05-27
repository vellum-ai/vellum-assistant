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
 * Props are intentionally PRIMITIVE (icon name + strings) rather than coupled
 * to `ToolCallCardStep`, so the pill is independently testable and reusable
 * outside the card pipeline.
 */

import { Bolt } from "lucide-react";

import { Typography } from "@vellum/design-library";

import { RiskBadge } from "@/domains/chat/components/risk-badge";
import { ICON_MAP } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import type { IconName } from "@/domains/chat/components/tool-progress-card/derive-step-label";

export interface ToolStepPillProps {
  iconName: IconName;
  label: string;
  riskLevel?: string;
  onClick?: () => void;
  tone?: "default" | "error";
  /** Accessible label for the button. Defaults to `View details: ${label}`. */
  ariaLabel?: string;
}

/** Shared layout classes applied to both the button and span variants. */
const BASE_CLASSES =
  "inline-flex min-w-0 max-w-full items-center gap-1 self-start rounded-full border px-[10px] py-[6px] text-left";

/** Interactive affordances added only when the pill renders as a button. */
const INTERACTIVE_CLASSES =
  "transition-colors hover:bg-[var(--surface-base)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)] cursor-pointer";

export function ToolStepPill({
  iconName,
  label,
  riskLevel,
  onClick,
  tone = "default",
  ariaLabel,
}: ToolStepPillProps) {
  const toneClasses =
    tone === "error"
      ? "border-[var(--system-negative-weak)] bg-[var(--system-negative-weak)] text-[var(--system-negative-strong)]"
      : "border-[var(--border-base)] bg-transparent text-[var(--content-default)]";

  const Glyph = ICON_MAP[iconName] ?? Bolt;
  const iconColor =
    tone === "error"
      ? "text-[var(--system-negative-strong)]"
      : "text-[var(--content-tertiary)]";

  const content = (
    <>
      <Glyph
        aria-hidden="true"
        className={`h-3.5 w-3.5 shrink-0 ${iconColor}`}
      />
      <Typography
        variant="body-small-default"
        className="min-w-0 truncate text-inherit"
      >
        {label}
      </Typography>
      <RiskBadge level={riskLevel} />
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        data-testid="tool-step-pill"
        aria-label={ariaLabel ?? `View details: ${label}`}
        onClick={onClick}
        className={`${BASE_CLASSES} ${INTERACTIVE_CLASSES} ${toneClasses}`}
      >
        {content}
      </button>
    );
  }

  return (
    <span
      data-testid="tool-step-pill"
      className={`${BASE_CLASSES} ${toneClasses}`}
    >
      {content}
    </span>
  );
}
