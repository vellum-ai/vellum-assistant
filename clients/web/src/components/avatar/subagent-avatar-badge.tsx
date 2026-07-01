// Collapsed-summary avatar unit: a 32px circle with an under-avatar status
// indicator (running dots / green check / red !). Figma node 6063:148535.

import { Check } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

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
    case "interrupted":
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
  interrupted: "interrupted",
};

export function SubagentAvatarBadge({
  subagentId,
  className,
}: SubagentAvatarBadgeProps) {
  // Atomic selector — re-render only when this subagent's status changes.
  const status = useSubagentStore((s) => s.byId[subagentId]?.status);
  const reduce = useReducedMotion();

  // Spawn race: no entry yet → circle with no indicator.
  const badgeState = status ? deriveBadgeState(status) : undefined;

  return (
    <div
      data-testid="subagent-avatar-badge"
      className={`relative flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-lift)] transition-colors hover:bg-[var(--surface-active)] ${className ?? ""}`.trim()}
    >
      <SubagentAvatarChip
        subagentId={subagentId}
        size={16}
        className="absolute top-[6px]"
      />

      {badgeState && (
        <span
          // role="img" exposes aria-label; the dots/glyphs are aria-hidden.
          role="img"
          data-testid="subagent-avatar-badge-status"
          data-status={status}
          aria-label={status && STATUS_ARIA_LABEL[status]}
          // Running dots sit at bottom-[6px] per the mock (6063:148464);
          // the terminal glyphs stay at bottom-[3px].
          className={`absolute left-1/2 flex -translate-x-1/2 items-center justify-center ${
            badgeState === "in-flight" ? "bottom-[6px]" : "bottom-[3px]"
          }`}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={badgeState}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={
                reduce
                  ? { duration: 0 }
                  : { duration: 0.15, ease: [0.16, 1, 0.3, 1] }
              }
              className="flex items-center justify-center"
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
            </motion.span>
          </AnimatePresence>
        </span>
      )}
    </div>
  );
}
