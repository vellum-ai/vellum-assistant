import { ChevronDown, ChevronUp } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { SubagentAvatarChip } from "@/components/avatar/subagent-avatar-chip";
import { ChatPill } from "@/domains/chat/components/chat-pill";
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
    <ChatPill
      onClick={onToggle}
      ariaLabel="Active subagents"
      ariaExpanded={expanded}
      size="compact"
    >
      <span className="inline-flex items-center gap-2">
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
      </span>
    </ChatPill>
  );
}
