// Collapsible wrapper for a set of spawned subagents: the SubagentAvatarRow
// summary when collapsed, the SubagentInlineProgressCard list when expanded.

import { ChevronUp } from "lucide-react";
import { useState } from "react";

import { Typography } from "@vellumai/design-library";

import { SubagentAvatarRow } from "@/domains/chat/components/subagent-inline-progress-card/subagent-avatar-row";
import { SubagentInlineProgressCard } from "@/domains/chat/components/subagent-inline-progress-card/subagent-inline-progress-card";

export interface SubagentSpawnGroupProps {
  subagentIds: string[];
  onSubagentClick?: (subagentId: string) => void;
  onStopSubagent?: (subagentId: string) => void;
}

export function SubagentSpawnGroup({
  subagentIds,
  onSubagentClick,
  onStopSubagent,
}: SubagentSpawnGroupProps) {
  // Default collapsed — the avatar summary is the resting state in the mocks.
  const [expanded, setExpanded] = useState(false);

  if (subagentIds.length === 0) return null;

  if (!expanded) {
    return (
      <SubagentAvatarRow
        subagentIds={subagentIds}
        onExpand={() => setExpanded(true)}
      />
    );
  }

  return (
    <div className="flex w-full flex-col">
      <div className="flex w-full flex-col gap-1.5">
        {subagentIds.map((id) => (
          <SubagentInlineProgressCard
            key={id}
            subagentId={id}
            onSubagentClick={onSubagentClick}
            onStopSubagent={onStopSubagent}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() => setExpanded(false)}
        aria-label="Collapse subagent details"
        data-testid="subagent-spawn-group-collapse"
        className="mt-2 flex cursor-pointer items-center gap-1"
      >
        <Typography
          variant="body-medium-default"
          className="text-[var(--content-tertiary)]"
        >
          Collapse
        </Typography>
        <ChevronUp className="h-3 w-3 text-[var(--content-tertiary)]" />
      </button>
    </div>
  );
}
