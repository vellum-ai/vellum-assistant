/**
 * Collapsed-summary subagent avatar unit (Figma node `6063:148535`, 32×32).
 *
 * Renders a 32px white circle holding the deterministic
 * `SubagentAvatarChip`, with a state-respective status indicator beneath
 * the avatar: pulsing running dots while in-flight, a green check when the
 * subagent completes, and a red ✕ when it's canceled (aborted) or fails.
 * The indicator reflects the subagent's ACTUAL live status — it never
 * shows a stuck running indicator on a finished subagent.
 *
 * The status buckets mirror `deriveCardState`'s loading / complete / error
 * split in `use-subagent-card-data` so the collapsed badge and the expanded
 * row read consistently. Badge state is exposed non-visually (via
 * `aria-label` + a `data-status` attr), not by colour alone.
 */

import { Check, X } from "lucide-react";

import { SubagentAvatarChip } from "@/components/avatar/subagent-avatar-chip";
import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import type { SubagentStatus } from "@vellumai/assistant-api";

export interface SubagentAvatarBadgeProps {
  subagentId: string;
  className?: string;
}

/** Three display buckets for the under-avatar indicator. */
type BadgeState = "in-flight" | "completed" | "errored";

/**
 * Map a subagent status to its badge bucket. Mirrors the loading / complete
 * / error split of `deriveCardState` in `use-subagent-card-data`:
 * `running` / `pending` / `awaiting_input` are in-flight, `completed` is a
 * clean finish, and `failed` / `aborted` (canceled) read as an error.
 */
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

/**
 * Accessible label for the indicator, exposing the precise state to
 * assistive tech (so canceled reads differently from failed even though they
 * share the red ✕ glyph). Keyed by the raw status, not the coarse bucket.
 */
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
  // Atomic selector: re-render only when this subagent's status changes.
  const status = useSubagentStore((s) => s.byId[subagentId]?.status);

  // Entry not in the store yet (spawn race) — render the circle without an
  // indicator rather than a stuck running state.
  const badgeState = status ? deriveBadgeState(status) : undefined;

  return (
    <div
      data-testid="subagent-avatar-badge"
      className={`relative flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-lift)] ${className ?? ""}`.trim()}
    >
      {/* Avatar sits slightly above centre (~6px from top) to leave room for
          the indicator beneath it, per the mock. */}
      <SubagentAvatarChip
        subagentId={subagentId}
        size={14}
        className="absolute top-[6px]"
      />

      {badgeState && (
        <span
          data-testid="subagent-avatar-badge-status"
          data-status={status}
          aria-label={status && STATUS_ARIA_LABEL[status]}
          className="absolute bottom-[3px] left-1/2 flex -translate-x-1/2 items-center justify-center"
        >
          {badgeState === "in-flight" && (
            <ThreeDotIndicator dotSize={3} gap={2} />
          )}
          {badgeState === "completed" && (
            <Check className="h-3 w-3 text-[var(--system-positive-strong)]" />
          )}
          {badgeState === "errored" && (
            <X className="h-3 w-3 text-[var(--system-negative-strong)]" />
          )}
        </span>
      )}
    </div>
  );
}
