import { Skeleton, cn } from "@vellumai/design-library";

const DEFAULT_LINE_CLASSES = "h-4 w-full rounded-md";

export interface SkeletonLinesProps {
  lines: number;
  lineClassName?: string;
  className?: string;
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
      role="status"
      aria-label={label}
      className={cn("space-y-2", className)}
    >
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          aria-hidden
          className={cn(DEFAULT_LINE_CLASSES, lineClassName)}
        />
      ))}
    </div>
  );
}
