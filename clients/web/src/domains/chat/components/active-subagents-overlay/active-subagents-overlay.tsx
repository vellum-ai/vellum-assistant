// Floating "Active Subagents" overlay: a collapsed avatar pill that expands
// into a scrollable panel of SubagentInlineProgressCard rows. Purely
// presentational and props-driven (PR 3 wires it from chat-route-content).
// Renders nothing when there are no active subagents.

import { useEffect, useRef, useState } from "react";

import { Typography } from "@vellumai/design-library";

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
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Defensive: collapse if the active set drains while open.
  useEffect(() => {
    if (subagentIds.length === 0) setExpanded(false);
  }, [subagentIds.length]);

  // While open, dismiss on outside pointerdown or Escape.
  useEffect(() => {
    if (!expanded) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setExpanded(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [expanded]);

  if (subagentIds.length === 0) return null;

  return (
    <div
      ref={containerRef}
      data-testid="active-subagents-overlay"
      className="pointer-events-auto flex w-full max-w-[589px] flex-col items-center gap-2"
    >
      <ActiveSubagentsPill
        subagentIds={subagentIds}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />

      {expanded && (
        <div className="flex w-full flex-col gap-4 rounded-xl bg-[var(--surface-lift)] p-4 shadow-lg">
          <Typography
            variant="title-small"
            className="text-[var(--content-emphasised)]"
          >
            {subagentIds.length} Active Subagents
          </Typography>
          <div className="flex max-h-[320px] flex-col gap-2 overflow-y-auto">
            {subagentIds.map((id) => (
              <SubagentInlineProgressCard
                key={id}
                subagentId={id}
                onSubagentClick={onSubagentClick}
                onStopSubagent={onStopSubagent}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
