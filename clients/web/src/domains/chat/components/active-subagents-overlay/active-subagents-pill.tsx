// Collapsed trigger for the active-subagents overlay: an overlapping stack of
// up to MAX_VISIBLE_SUBAGENT_AVATARS subagent avatars, a "+N" overflow chip,
// and a chevron that reflects the expanded state. ChatPill-style chrome.

import { ChevronDown, ChevronUp } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { SubagentAvatarChip } from "@/components/avatar/subagent-avatar-chip";
import { MAX_VISIBLE_SUBAGENT_AVATARS } from "@/domains/chat/components/subagent-inline-progress-card/subagent-avatar-row";

export interface ActiveSubagentsPillProps {
  subagentIds: string[];
  expanded: boolean;
  onToggle: () => void;
}

export function ActiveSubagentsPill({
  subagentIds,
  expanded,
  onToggle,
}: ActiveSubagentsPillProps) {
  const visibleIds = subagentIds.slice(0, MAX_VISIBLE_SUBAGENT_AVATARS);
  const overflowCount = subagentIds.length - MAX_VISIBLE_SUBAGENT_AVATARS;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label="Active subagents"
      data-testid="active-subagents-pill"
      className="pointer-events-auto inline-flex cursor-pointer items-center gap-2 rounded-full bg-[var(--surface-lift)] px-3 py-1.5 shadow-md"
    >
      <span className="flex items-center">
        {visibleIds.map((id, index) => (
          <SubagentAvatarChip
            key={id}
            subagentId={id}
            size={16}
            className={
              index === 0
                ? undefined
                : "-ml-1 rounded-full ring-2 ring-[var(--surface-lift)]"
            }
          />
        ))}
      </span>

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
    </button>
  );
}
