import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";

import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import type { ToolProgressCardState } from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell";

/**
 * The byte-identical "local copy" of the shell's StatusIndicator that the four
 * background-process inline cards each re-declared. Extracted here so the
 * generic {@link InlineProcessCard} and the per-surface cards share one
 * implementation.
 *
 * Renders the full five-state mapping (the ACP card carried the richest set,
 * which is the superset of the others):
 *   - `loading`  → pulsing {@link ThreeDotIndicator} (no `data-state`)
 *   - `complete` → green {@link CheckCircle2}
 *   - `warning`  → amber {@link AlertTriangle} (e.g. a cancelled-but-completed
 *     run = partial work — distinct from a red error)
 *   - `denied` / `error` → red {@link AlertCircle}
 *
 * Terminal icons carry `data-state` so the detail panel and tests can read the
 * settled state; the running indicator has none. Icons are `aria-hidden` — the
 * card's open affordance owns the accessible label.
 */
export const INLINE_CARD_STATUS_TESTID = "inline-card-status-indicator";

export function InlineCardStatusIcon({
  state,
}: {
  state: ToolProgressCardState;
}) {
  switch (state) {
    case "loading":
      return (
        <ThreeDotIndicator
          data-testid={INLINE_CARD_STATUS_TESTID}
          className="shrink-0"
        />
      );
    case "complete":
      return (
        <CheckCircle2
          data-testid={INLINE_CARD_STATUS_TESTID}
          aria-hidden="true"
          data-state="complete"
          className="h-[14px] w-[14px] shrink-0 text-[var(--system-positive-strong)]"
        />
      );
    case "warning":
      return (
        <AlertTriangle
          data-testid={INLINE_CARD_STATUS_TESTID}
          aria-hidden="true"
          data-state="warning"
          className="h-[14px] w-[14px] shrink-0 text-[var(--system-mid-strong)]"
        />
      );
    case "denied":
    case "error":
    default:
      return (
        <AlertCircle
          data-testid={INLINE_CARD_STATUS_TESTID}
          aria-hidden="true"
          data-state={state}
          className="h-[14px] w-[14px] shrink-0 text-[var(--system-negative-strong)]"
        />
      );
  }
}
