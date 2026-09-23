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
}

export function StatSquare({
  icon,
  value,
  label,
  tone = "default",
  className,
  ref,
  ...rest
}: StatSquareProps) {
  return (
    <div
      {...rest}
      ref={ref}
      data-slot="stat-square"
      className={cn(
        "flex flex-1 items-center gap-3 rounded-xl bg-[var(--surface-base)] p-3",
        className,
      )}
    >
      {icon ? (
        // The chip sizes and colours its own glyph, so a caller passes a bare
        // icon. 32px with a 14px glyph is `Button`'s regular icon box.
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-lift)] text-[var(--content-emphasised)] [&_svg]:size-3.5"
        >
          {icon}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-col">
        {/* A value can outrun the tile (a model id), so it is cut rather than
            left to spill, and a caller whose value can run long passes
            `title`. `body-large-default` is the 16/500 step with leading: the
            cut needs a line box its descenders fit inside. */}
        <Typography
          variant="body-large-default"
          className={cn("block truncate", VALUE_TONE_CLASSES[tone])}
        >
          {value}
        </Typography>
        {/* A label, on the label step: one line, never cut. Cutting a
            `line-height: 1` step clips its descenders, and a label is short
            copy the tile is laid out to fit. */}
        <Typography
          variant="body-small-default"
          className="mt-1 whitespace-nowrap text-[var(--content-tertiary)]"
        >
          {label}
        </Typography>
      </div>
    </div>
  );
}
