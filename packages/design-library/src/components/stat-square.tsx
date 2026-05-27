import { type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn";

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
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-lift)] text-[var(--content-emphasised)]"
        >
          {icon}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-col">
        <span
          className={cn(
            "text-title-small leading-none",
            VALUE_TONE_CLASSES[tone],
          )}
        >
          {value}
        </span>
        <span className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
          {label}
        </span>
      </div>
    </div>
  );
}
