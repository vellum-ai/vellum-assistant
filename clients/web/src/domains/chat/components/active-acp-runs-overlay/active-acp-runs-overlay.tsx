import { ActiveOverlayShell } from "@/domains/chat/components/active-overlay-shell";
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
  if (acpRunIds.length === 0) return null;

  return (
    <ActiveOverlayShell
      testId="active-acp-runs-overlay"
      title={`${acpRunIds.length} Active Run${
        acpRunIds.length === 1 ? "" : "s"
      }`}
      renderPill={({ expanded, onToggle }) => (
        <ActiveAcpRunsPill
          acpRunIds={acpRunIds}
          expanded={expanded}
          onToggle={onToggle}
        />
      )}
    >
      {({ close }) =>
        acpRunIds.map((id) => (
          <AcpRunInlineProgressCard
            key={id}
            acpSessionId={id}
            // Opening drills into the detail panel and dismisses the dropdown
            // so the two layers stop competing for width.
            onAcpRunClick={
              onAcpRunClick
                ? (sid) => {
                    onAcpRunClick(sid);
                    close();
                  }
                : undefined
            }
          />
        ))
      }
    </ActiveOverlayShell>
  );
}
