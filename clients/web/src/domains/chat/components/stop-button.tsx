import { Square } from "lucide-react";

import { Typography } from "@vellumai/design-library";

/**
 * Outline "Stop" button shared by the workflow + subagent detail panel headers,
 * so both share one set of dimensions (h-8, `Square` glyph, negative-strong
 * outline that fills on hover). The label/aria copy varies per panel, so the
 * caller supplies `ariaLabel` and `onClick`.
 */
export function StopButton({
  onClick,
  ariaLabel,
}: {
  onClick: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--system-negative-strong)] bg-transparent px-2.5 py-1.5 text-[var(--system-negative-strong)] transition-colors hover:bg-[var(--system-negative-weak)]"
    >
      <Square className="h-3 w-3" fill="currentColor" />
      <Typography variant="label-small-default">Stop</Typography>
    </button>
  );
}
