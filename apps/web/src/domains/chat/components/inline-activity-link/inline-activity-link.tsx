/**
 * Shared presentational inline activity link. The single underlying component
 * for both the lone "Thought process" link and the lone single-tool chip:
 * a minimal, container-less affordance (leading glyph + label + optional risk
 * badge + trailing chevron) that toggles the shared tool-detail side drawer.
 *
 * Purely presentational — no store access. Callers own `active` + `onClick`,
 * so the same component drives the thinking link (matched on thinking text)
 * and the tool chip (matched on tool-call id) without knowing which it is.
 *
 * The trailing `ChevronRight` signals "opens a drawer" (vs the card's
 * expand-in-place up/down chevron). The button keeps consistent padding so the
 * active highlight fills behind the content without shifting layout.
 */

import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/utils/misc";
import { RiskBadge } from "@/domains/chat/components/risk-badge";

export interface InlineActivityLinkProps {
  /** Leading glyph (Brain for thinking, a tool icon for a tool chip). */
  icon: ReactNode;
  label: string;
  /** Renders a display-only `<RiskBadge>` after the label when present. */
  riskLevel?: string;
  active?: boolean;
  tone?: "default" | "error";
  onClick: () => void;
  ariaLabel: string;
  "data-testid"?: string;
  /** Trailing `ChevronRight` affordance — the "opens drawer" cue. */
  showChevron?: boolean;
}

export function InlineActivityLink({
  icon,
  label,
  riskLevel,
  active = false,
  tone = "default",
  onClick,
  ariaLabel,
  "data-testid": dataTestId = "inline-activity-link",
  showChevron = true,
}: InlineActivityLinkProps) {
  const isError = tone === "error";
  return (
    <button
      type="button"
      data-testid={dataTestId}
      data-active={active ? "true" : "false"}
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        "group inline-flex items-center gap-2 -mx-1.5 px-1.5 py-1 rounded-md text-left text-[13px] font-medium transition-colors cursor-pointer",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]",
        active
          ? "bg-[var(--surface-active)] text-[var(--content-default)]"
          : "text-[var(--content-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
        isError && "text-[var(--system-negative-strong)]",
      )}
    >
      <span
        className={cn(
          "inline-flex shrink-0 items-center text-[var(--content-tertiary)]",
          isError && "text-[var(--system-negative-strong)]",
        )}
      >
        {icon}
      </span>
      <span>{label}</span>
      {riskLevel ? <RiskBadge level={riskLevel} /> : null}
      {showChevron ? (
        <ChevronRight
          className="size-3.5 shrink-0 text-[var(--content-tertiary)]"
          aria-hidden
        />
      ) : null}
    </button>
  );
}
