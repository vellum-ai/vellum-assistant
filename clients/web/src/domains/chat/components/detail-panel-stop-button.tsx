/**
 * Icon-only danger "Stop" control for detail-panel headers (subagent,
 * workflow, background task, ACP run). A bordered square button holding a
 * square glyph, the shared right-aligned header control. Keeping every panel
 * on this one component stops their headers from drifting apart.
 *
 * Corner radius and glyph size are both the design-library defaults (no
 * override) so this matches the sibling Back/Close buttons in the same header.
 * The glyph is stroked, not filled, for the same reason.
 *
 * The gap to the Close button that always follows is trimmed to 8px by
 * `DetailShellHeader` itself, not by this component: every `headerActions`
 * control gets that treatment for free.
 *
 * The hover override keeps this button's weak-fill hover instead of
 * `dangerOutline`'s foreground/border recolor. Letting the recolor land on top
 * of the fill drops the glyph to ~2.4:1 in light and ~2.0:1 in dark; holding
 * the foreground at `--system-negative-strong` keeps it at ~3.2:1 / ~2.9:1.
 */

import { Square } from "lucide-react";

import { useTranslation } from "@/i18n";
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
  const { t } = useTranslation("chat");
  return (
    <Button
      variant="dangerOutline"
      iconOnly={<Square />}
      aria-label={ariaLabel}
      tooltip={t("detailPanelStopButton.tooltip")}
      onClick={onStop}
      disabled={disabled}
      className="shrink-0 hover:border-[var(--system-negative-strong)] hover:bg-[var(--system-negative-weak)] hover:[--vbtn-fg:var(--system-negative-strong)]"
    />
  );
}
