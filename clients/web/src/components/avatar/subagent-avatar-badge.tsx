// Collapsed-summary avatar unit: a 32px circle with an under-avatar status
// indicator (running dots / green check / red !). Figma node 6063:148535.

import { Check } from "lucide-react";

import { SubagentAvatarChip } from "@/components/avatar/subagent-avatar-chip";
import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import type { SubagentStatus } from "@vellumai/assistant-api";

export interface SubagentAvatarBadgeProps {
  subagentId: string;
  className?: string;
}

type BadgeState = "in-flight" | "completed" | "errored";

function deriveBadgeState(status: SubagentStatus): BadgeState {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "aborted":
      return "errored";
    default:
      return "in-flight";
  }
}

// Per-status (not per-bucket) so "canceled" reads distinctly from "failed".
const STATUS_ARIA_LABEL: Record<SubagentStatus, string> = {
  running: "running",
  pending: "pending",
  awaiting_input: "awaiting input",
  completed: "completed",
  failed: "failed",
  aborted: "canceled",
};

export function SubagentAvatarBadge({
  subagentId,
  className,
}: SubagentAvatarBadgeProps) {
  // Atomic selector — re-render only when this subagent's status changes.
  const status = useSubagentStore((s) => s.byId[subagentId]?.status);

  // Spawn race: no entry yet → circle with no indicator.
  const badgeState = status ? deriveBadgeState(status) : undefined;

  return (
    <div
      data-testid="subagent-avatar-badge"
      className={`relative flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-lift)] transition-colors hover:bg-[var(--surface-active)] ${className ?? ""}`.trim()}
    >
      <SubagentAvatarChip
        subagentId={subagentId}
        size={14}
        className="absolute top-[6px]"
      />

      {badgeState && (
        <span
          // role="img" exposes aria-label; the dots/glyphs are aria-hidden.
          role="img"
          data-testid="subagent-avatar-badge-status"
          data-status={status}
          aria-label={status && STATUS_ARIA_LABEL[status]}
          className="absolute bottom-[3px] left-1/2 flex -translate-x-1/2 items-center justify-center"
        >
          {badgeState === "in-flight" && (
            <ThreeDotIndicator dotSize={3} gap={2} />
          )}
          {badgeState === "completed" && (
            <Check className="h-2.5 w-2.5 text-[var(--system-positive-strong)]" />
          )}
          {badgeState === "errored" && (
            <span className="text-[11px] font-bold leading-none text-[var(--system-negative-strong)]">
              !
            </span>
          )}
        </span>
      )}
    </div>
  );
}
