/**
 * Outlined danger "Stop" button for detail-panel headers (subagent, background
 * task). A bordered button with a filled square glyph + a "Stop" label — the
 * shared right-aligned header control, distinct from the inline cards'
 * `dangerGhost` icon-only stop. Keeping both panels on this one component stops
 * their headers from drifting apart.
 */

import { Square } from "lucide-react";

import { Typography } from "@vellumai/design-library";

export interface DetailPanelStopButtonProps {
  onStop: () => void;
  /** Accessible label, e.g. "Stop subagent" / "Stop command". */
  ariaLabel: string;
  /** Disable after a click to guard against a double-cancel. */
  disabled?: boolean;
}

export function DetailPanelStopButton({
  onStop,
  ariaLabel,
  disabled,
}: DetailPanelStopButtonProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onStop}
      disabled={disabled}
      className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--system-negative-strong)] bg-transparent px-2.5 py-1.5 text-[var(--system-negative-strong)] transition-colors hover:bg-[var(--system-negative-weak)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Square className="h-3 w-3" fill="currentColor" />
      <Typography variant="label-small-default">Stop</Typography>
    </button>
  );
}
