/**
 * Outlined danger "Stop" button for detail-panel headers (subagent, background
 * task). A bordered button with a filled square glyph + a "Stop" label — the
 * shared right-aligned header control, distinct from the inline cards'
 * `dangerGhost` icon-only stop. Keeping both panels on this one component stops
 * their headers from drifting apart.
 *
 * Corner radius is the design-library default (no override) so it matches the
 * sibling Back/Close buttons in the same header.
 *
 * The gap to the Close button that always follows is trimmed to 8px by
 * `DetailShellHeader` itself, not by this component: every `headerActions`
 * control gets that treatment for free.
 *
 * The hover override keeps this button's weak-fill hover instead of
 * `dangerOutline`'s text/border recolor. Letting the recolor land on top of the
 * fill drops the label to ~2.4:1 in light and ~2.0:1 in dark; holding the
 * foreground at `--system-negative-strong` keeps it at ~3.2:1 / ~2.9:1.
 */

import { Square } from "lucide-react";

import { Button } from "@vellumai/design-library";

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
    <Button
      variant="dangerOutline"
      leftIcon={<Square className="h-3 w-3" fill="currentColor" />}
      aria-label={ariaLabel}
      onClick={onStop}
      disabled={disabled}
      className="shrink-0 hover:border-[var(--system-negative-strong)] hover:bg-[var(--system-negative-weak)] hover:[--vbtn-fg:var(--system-negative-strong)]"
    >
      Stop
    </Button>
  );
}
