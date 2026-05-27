import { type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn";

export interface SkillRowProps extends Omit<ComponentProps<"div">, "title"> {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}

export function SkillRow({
  icon,
  title,
  subtitle,
  action,
  className,
  ref,
  ...rest
}: SkillRowProps) {
  return (
    <div
      {...rest}
      ref={ref}
      data-slot="skill-row"
      className={cn(
        "flex flex-col gap-4 rounded-lg bg-[var(--surface-base)] px-2 py-1.5",
        "sm:flex-row sm:items-center sm:justify-between sm:gap-3",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        {icon ? (
          <span
            aria-hidden
            className="flex h-6 w-6 shrink-0 items-center justify-center text-[var(--content-emphasised)]"
          >
            {icon}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-body-medium-default text-[var(--content-default)]">
            {title}
          </span>
          {subtitle ? (
            <span className="text-body-small-default text-[var(--content-tertiary)]">
              {subtitle}
            </span>
          ) : null}
        </div>
      </div>
      {action ? (
        <div className="flex shrink-0 items-center gap-1">{action}</div>
      ) : null}
    </div>
  );
}
