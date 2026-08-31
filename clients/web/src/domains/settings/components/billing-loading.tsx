import { Card, Skeleton, cn } from "@vellumai/design-library";
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

const DEFAULT_LINE_CLASSES = "h-4 w-full rounded-md";

export interface ContentRevealProps {
  children: ReactNode;
  className?: string;
}

/** Fades resolved content in after a skeleton; instant under reduced motion. */
export function ContentReveal({ children, className }: ContentRevealProps) {
  const prefersReducedMotion = useReducedMotion();
  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

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
    <div role="status" aria-label={label} className={cn("space-y-2", className)}>
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

export interface SkeletonCardBlockProps {
  className?: string;
  label?: string;
}

export function SkeletonCardBlock({ className, label }: SkeletonCardBlockProps) {
  return (
    <Card padding="md" className={className}>
      <Skeleton aria-hidden className="h-5 w-32 rounded-md" />
      <SkeletonLines lines={2} label={label} className="mt-4" />
    </Card>
  );
}
