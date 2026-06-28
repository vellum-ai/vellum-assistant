import { useEffect, useRef, useState } from "react";

import { Typography } from "@vellumai/design-library";

import { ActiveAcpRunsPill } from "@/domains/chat/components/active-acp-runs-overlay/active-acp-runs-pill";
import { AcpRunInlineProgressCard } from "@/domains/chat/components/acp-run-inline-card/acp-run-inline-progress-card";

export interface ActiveAcpRunsOverlayProps {
  acpRunIds: string[];
  onAcpRunClick?: (acpSessionId: string) => void;
}

export function ActiveAcpRunsOverlay({
  acpRunIds,
  onAcpRunClick,
}: ActiveAcpRunsOverlayProps) {
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Defensive: collapse if the active set drains while open.
  useEffect(() => {
    if (acpRunIds.length === 0) setExpanded(false);
  }, [acpRunIds.length]);

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

  if (acpRunIds.length === 0) return null;

  return (
    <div
      ref={containerRef}
      data-testid="active-acp-runs-overlay"
      // none here so gutter clicks reach the transcript; pill + panel re-enable.
      className="pointer-events-none flex w-full max-w-[589px] flex-col items-center gap-2"
    >
      <ActiveAcpRunsPill
        acpRunIds={acpRunIds}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />

      {expanded && (
        <div className="pointer-events-auto flex w-full flex-col gap-4 rounded-xl bg-[var(--surface-lift)] px-3 py-4 shadow-lg">
          <Typography
            variant="title-small"
            className="text-[var(--content-emphasised)]"
          >
            {acpRunIds.length} Active Run
            {acpRunIds.length === 1 ? "" : "s"}
          </Typography>
          <div className="flex max-h-[320px] flex-col gap-2 overflow-y-auto">
            {acpRunIds.map((id) => (
              <AcpRunInlineProgressCard
                key={id}
                acpSessionId={id}
                onAcpRunClick={onAcpRunClick}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
