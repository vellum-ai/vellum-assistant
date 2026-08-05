// Collapsed-summary avatar unit: a pill carrying a status glyph (running dots
// / check / X) in a fixed slot to the left of the subagent's avatar. Terminal
// states tint the pill with the matching weak system fill. The glyphs and the
// slot are sized in px so they hold their proportions at any root font size;
// the pill's height tracks the root like the rest of the row.

import { Check, X } from "lucide-react";
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

// Only a pill that can still change carries the hover swap, so the terminal
// tints deliberately have none.
function pillBackgroundClass(badgeState: BadgeState | undefined): string {
  switch (badgeState) {
    case "completed":
      return "bg-[var(--system-positive-weak)]";
    case "errored":
      return "bg-[var(--system-negative-weak)]";
    default:
      return "bg-[var(--surface-lift)] hover:bg-[var(--surface-active)]";
  }
}

const BADGE_STATE_GLYPH: Record<BadgeState, "dots" | "check" | "cross"> = {
  "in-flight": "dots",
  completed: "check",
  errored: "cross",
};

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
  // Atomic selector: re-render only when this subagent's status changes.
  const status = useSubagentStore((s) => s.byId[subagentId]?.status);
  const reduce = useReducedMotion();

  // Spawn race: no entry yet → pill with an empty glyph slot.
  const badgeState = status ? deriveBadgeState(status) : undefined;

  // The pill is `calc(1rem + 30px)` wide because its contents are two
  // different units: the padding and the gap are rem (0.75 + 0.25), while the
  // 14px slot and the 16px avatar are px that no root font size changes. A
  // single rem value is exact only at a 16px root, spilling the avatar past
  // the rounded edge below that and leaving dead space above it.
  return (
    <div
      data-testid="subagent-avatar-badge"
      className={`inline-flex h-8 w-[calc(1rem+30px)] shrink-0 items-center gap-1 rounded-full px-1.5 transition-colors ${pillBackgroundClass(badgeState)} ${className ?? ""}`.trim()}
    >
      {/* The glyph slot is a fixed 14px and always renders, including before
          the store entry lands. The three glyphs are different widths (13px
          dots, 10px check, 10px X), and the pill packs its items at
          flex-start, so a slot that sized to its content would slide the
          avatar about 3px left the moment a subagent settles. The width is px
          rather than rem so the 13px dots always fit it. */}
      <span
        data-testid="subagent-avatar-badge-slot"
        className="flex w-[14px] shrink-0 items-center justify-center"
      >
        {badgeState && (
          <span
            // role="img" exposes aria-label; the dots/glyphs are aria-hidden.
            role="img"
            data-testid="subagent-avatar-badge-status"
            data-status={status}
            aria-label={status && STATUS_ARIA_LABEL[status]}
            className="flex items-center justify-center"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={badgeState}
                data-glyph={BADGE_STATE_GLYPH[badgeState]}
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
                  <Check className="h-[10px] w-[10px] text-[var(--system-positive-on-weak)]" />
                )}
                {badgeState === "errored" && (
                  <X className="h-[10px] w-[10px] text-[var(--system-negative-on-weak)]" />
                )}
              </motion.span>
            </AnimatePresence>
          </span>
        )}
      </span>

      <SubagentAvatarChip
        subagentId={subagentId}
        size={16}
        className="shrink-0"
      />
    </div>
  );
}
