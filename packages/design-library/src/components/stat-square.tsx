import { Loader2 } from "lucide-react";
import { type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn";
import { Typography } from "./typography";

export type StatSquareTone = "default" | "negative" | "muted";

const VALUE_TONE_CLASSES: Record<StatSquareTone, string> = {
  default: "text-[var(--content-default)]",
  negative: "text-[var(--system-negative-strong)]",
  muted: "text-[var(--content-tertiary)]",
};

export interface StatSquareProps extends ComponentProps<"div"> {
  icon?: ReactNode;
  value: ReactNode;
  label: ReactNode;
  tone?: StatSquareTone;
  /**
   * The value is on its way. The icon and label are known before the data
   * is, so they stay, and a spinner the size of the value's text holds its
   * line; the tile keeps the height it has once the value arrives. The
   * spinner is tertiary and stops under reduced motion. The tile sets
   * `aria-busy` while it waits, and `value` is not shown.
   */
  loading?: boolean;
}

export function StatSquare({
  icon,
  value,
  label,
  tone = "default",
  loading = false,
  className,
  ref,
  ...rest
}: StatSquareProps) {
  return (
    <div
      {...rest}
      ref={ref}
      aria-busy={loading ? true : rest["aria-busy"]}
      data-slot="stat-square"
      className={cn(
        "flex flex-1 items-center gap-3 rounded-xl bg-[var(--surface-base)] p-3",
        className,
      )}
    >
      {icon ? (
        // The chip sizes and colours its own glyph, so a caller passes a bare
        // icon. 32px with a 14px glyph is `Button`'s regular icon box. The
        // glyph is decoration, so it takes a supporting step on the content
        // ramp and the value stays the strongest thing in the tile.
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-lift)] text-[var(--content-secondary)] [&_svg]:size-3.5"
        >
          {icon}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-col">
        {/* A value can outrun the tile (a model id), so it is cut rather than
            left to spill, and carries its own text as a tooltip so the cut
            part stays readable, the way `Select` pairs the two on its
            trigger. `body-large-default` is the 16/500 step with leading:
            the cut needs a line box its descenders fit inside. */}
        <Typography
          variant="body-large-default"
          title={
            !loading && (typeof value === "string" || typeof value === "number")
              ? String(value)
              : undefined
          }
          className={cn("block truncate", VALUE_TONE_CLASSES[tone])}
        >
          {loading ? (
            <Loader2
              aria-hidden
              className="inline-block size-[1em] animate-spin align-middle text-[var(--content-tertiary)] motion-reduce:animate-none"
            />
          ) : (
            value
          )}
        </Typography>
        {/* A label wraps rather than being cut or spilling past the tile,
            so a long translation stays whole and inside it. Text that can
            run to a second line needs the 12px step with leading, and that
            leading is the whole gap under the value: the two lines are one
            pair and sit together. */}
        <Typography
          variant="body-small-lighter"
          className="text-[var(--content-secondary)]"
        >
          {label}
        </Typography>
      </div>
    </div>
  );
}
