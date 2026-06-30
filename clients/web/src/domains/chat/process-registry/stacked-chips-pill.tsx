import { ChevronDown, ChevronUp } from "lucide-react";
import { type ReactNode } from "react";

import { Typography } from "@vellumai/design-library";

import { ChatPill } from "@/domains/chat/components/chat-pill";

export interface StackedChipsPillProps {
  /** Ids backing each stacked chip. */
  ids: string[];
  /**
   * Renders a single stacked chip for one id. The chip owns its own visuals
   * (avatar / icon / glyph) and the stacking offset (`-ml-1 ring-2` for every
   * chip past the first), mirroring the per-surface pills this generalizes.
   */
  renderChip: (id: string) => ReactNode;
  /** Visible-chip cap before the remainder collapses to a "+N" badge. */
  max: number;
  /** Whether the owning overlay is expanded (drives the chevron direction). */
  expanded: boolean;
  /** Toggles the owning overlay open/closed. */
  onToggle: () => void;
  /** Accessible label for the pill button. */
  ariaLabel: string;
}

/**
 * Shared stacked-chip pill body for chat-overlay "active process" affordances
 * (subagents, ACP runs, background tasks). Renders up to `max` overlapping
 * chips, a "+N" overflow badge when there are more, and an expand/collapse
 * chevron — all inside a single compact `ChatPill` button.
 *
 * Pure presentational: chip visuals and store reads live in `renderChip`.
 */
export function StackedChipsPill({
  ids,
  renderChip,
  max,
  expanded,
  onToggle,
  ariaLabel,
}: StackedChipsPillProps) {
  const visibleIds = ids.slice(0, max);
  const overflowCount = ids.length - max;

  return (
    <ChatPill
      onClick={onToggle}
      ariaLabel={ariaLabel}
      ariaExpanded={expanded}
      size="compact"
    >
      {/* pointer-events-none so the ChatPill button owns clicks + cursor —
          clicking any chip toggles. */}
      <span className="pointer-events-none inline-flex items-center gap-2">
        <span className="flex items-center">{visibleIds.map(renderChip)}</span>

        {overflowCount > 0 && (
          <Typography
            variant="body-small-default"
            className="text-[var(--content-emphasised)]"
          >
            +{overflowCount}
          </Typography>
        )}

        {expanded ? (
          <ChevronUp className="h-3 w-3 text-[var(--content-tertiary)]" />
        ) : (
          <ChevronDown className="h-3 w-3 text-[var(--content-tertiary)]" />
        )}
      </span>
    </ChatPill>
  );
}
