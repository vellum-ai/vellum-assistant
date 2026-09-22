/**
 * One question option's row contents: the hotkey badge, the label, its
 * description, and a check when it is the chosen one.
 *
 * Shared so an option reads the same wherever it is shown. The interactive
 * card above the composer wraps it in a button and shows the badge, which
 * names the key that picks it. The tool drawer draws it flat and without the
 * badge: nothing there is pressable, so a key number would promise a shortcut
 * that does not exist. There, an option the user passed over draws `muted`, so
 * the one they chose leads while the rest stay readable.
 */

import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { Typography } from "@vellumai/design-library";

export function RowGlyph({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="text-body-small-default flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--surface-base)] text-[color:var(--content-secondary)]"
    >
      {children}
    </span>
  );
}

export interface QuestionRowContentsProps {
  /**
   * The key that picks this option, shown as a badge. Left out where no key
   * picks it: a touch device, or the tool drawer, where nothing is pressable.
   */
  badge?: number;
  label: string;
  description?: string;
  showCheck: boolean;
  /**
   * Draw the row in the secondary text colour, for an option that was on offer
   * but not taken. A colour token rather than opacity, so the row stays as
   * legible as any other secondary text.
   */
  muted?: boolean;
}

export function QuestionRowContents({
  badge,
  label,
  description,
  showCheck,
  muted = false,
}: QuestionRowContentsProps) {
  return (
    <span className="flex w-full min-w-0 items-center gap-3">
      {badge !== undefined && <RowGlyph>{badge}</RowGlyph>}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Typography
          variant="body-medium-default"
          as="span"
          className={
            muted
              ? "text-[color:var(--content-tertiary)]"
              : "text-[color:var(--content-default)]"
          }
        >
          {label}
        </Typography>
        {description && (
          <Typography
            variant="body-small-default"
            as="span"
            className="text-[color:var(--content-tertiary)]"
          >
            {description}
          </Typography>
        )}
      </span>
      {showCheck && (
        <Check
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-[var(--primary-base)]"
        />
      )}
    </span>
  );
}
