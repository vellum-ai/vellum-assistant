import { Skeleton, cn } from "@vellumai/design-library";

export interface SkeletonLinesProps {
  lines: number;
  lineClassName?: string;
  className?: string;
  /**
   * Announces the stack as a live region. Cards pass it whenever they load on
   * their own; a surface that already labels an outer region around several
   * placeholders leaves it off, so a screen reader hears one announcement
   * instead of one per placeholder.
   */
  label?: string;
}

/**
 * Stack of shimmer rows. Callers size the rows through `lineClassName` and the
 * stack through `className` so the placeholder holds the resolved height.
 */
export function SkeletonLines({
  lines,
  lineClassName,
  className,
  label,
}: SkeletonLinesProps) {
  return (
    <div
      role={label == null ? undefined : "status"}
      aria-label={label}
      className={cn("space-y-2", className)}
    >
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          aria-hidden
          className={cn("w-full rounded-md", lineClassName)}
        />
      ))}
    </div>
  );
}
