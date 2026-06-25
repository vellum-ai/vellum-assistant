import { ActiveOverlayShell } from "@/domains/chat/components/active-overlay-shell";
import { ActiveSubagentsPill } from "@/domains/chat/components/active-subagents-overlay/active-subagents-pill";
import { SubagentInlineProgressCard } from "@/domains/chat/components/subagent-inline-progress-card/subagent-inline-progress-card";

export interface ActiveSubagentsOverlayProps {
  subagentIds: string[];
  onSubagentClick?: (subagentId: string) => void;
  onStopSubagent?: (subagentId: string) => void;
}

export function ActiveSubagentsOverlay({
  subagentIds,
  onSubagentClick,
  onStopSubagent,
}: ActiveSubagentsOverlayProps) {
  if (subagentIds.length === 0) return null;

  return (
    <ActiveOverlayShell
      testId="active-subagents-overlay"
      title={`${subagentIds.length} Active Subagent${
        subagentIds.length === 1 ? "" : "s"
      }`}
      renderPill={({ expanded, onToggle }) => (
        <ActiveSubagentsPill
          subagentIds={subagentIds}
          expanded={expanded}
          onToggle={onToggle}
        />
      )}
    >
      {subagentIds.map((id) => (
        <SubagentInlineProgressCard
          key={id}
          subagentId={id}
          onSubagentClick={onSubagentClick}
          onStopSubagent={onStopSubagent}
        />
      ))}
    </ActiveOverlayShell>
  );
}
