/**
 * The tinted glyph that leads a checklist row (Figma: New-App `8300:168065`).
 *
 * A 26px disc filled with the task's weak accent, carrying the task's own 12px
 * glyph in the matching strong one. The pair comes straight from the token set
 * rather than being mixed here, so the modal and the full list page cannot
 * drift apart on the same task's colour.
 *
 * A finished task swaps the whole pair for the positive tokens and a check:
 * the row's status has to read at a glance from across the modal, which a
 * recoloured disc alone does not do.
 */

import { Check, type LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "@vellumai/design-library";

import type { ActivationColor } from "../catalog";

/**
 * The disc and glyph each catalog colour resolves to. Five of the seven
 * already have a semantic role in the token set; orange and purple are carried
 * by the decorative accent pair added for this palette.
 */
const ACTIVATION_ACCENT_TOKENS: Record<
  ActivationColor,
  { weak: string; strong: string }
> = {
  blue: {
    weak: "var(--system-info-weak)",
    strong: "var(--system-info-strong)",
  },
  teal: {
    weak: "var(--feed-digest-weak)",
    strong: "var(--feed-digest-strong)",
  },
  yellow: {
    weak: "var(--feed-thread-weak)",
    strong: "var(--feed-thread-strong)",
  },
  pink: {
    weak: "var(--feed-nudge-weak)",
    strong: "var(--feed-nudge-strong)",
  },
  green: {
    weak: "var(--system-positive-weak)",
    strong: "var(--system-positive-on-weak)",
  },
  orange: {
    weak: "var(--accent-orange-weak)",
    strong: "var(--accent-orange-strong)",
  },
  purple: {
    weak: "var(--accent-purple-weak)",
    strong: "var(--accent-purple-strong)",
  },
};

const DONE_ACCENT = ACTIVATION_ACCENT_TOKENS.green;

export type ActivationTaskIconState = "todo" | "done";

export interface ActivationTaskIconProps {
  /** The task's own glyph, from the catalog. */
  icon: LucideIcon;
  color: ActivationColor;
  /** `done` replaces the glyph with a check on the positive disc. */
  state?: ActivationTaskIconState;
  className?: string;
}

export function ActivationTaskIcon({
  icon: Icon,
  color,
  state = "todo",
  className,
}: ActivationTaskIconProps): ReactNode {
  const done = state === "done";
  const accent = done ? DONE_ACCENT : ACTIVATION_ACCENT_TOKENS[color];
  const style: CSSProperties = {
    backgroundColor: accent.weak,
    color: accent.strong,
  };

  return (
    <span
      aria-hidden="true"
      style={style}
      className={cn(
        "flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full",
        className,
      )}
    >
      {done ? (
        <Check className="h-3 w-3" strokeWidth={3} />
      ) : (
        <Icon className="h-3 w-3" />
      )}
    </span>
  );
}
