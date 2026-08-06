import { createElement, type HTMLAttributes, type Ref } from "react";

import { cn } from "../utils/cn";

export type SkeletonAs = "div" | "span";

export interface SkeletonProps extends HTMLAttributes<HTMLElement> {
  /**
   * Root element. Use `"span"` when the placeholder sits in phrasing
   * content (e.g. inline in a paragraph), where a `div` is invalid HTML.
   */
  as?: SkeletonAs;
  className?: string;
  ref?: Ref<HTMLElement>;
}

/**
 * Loading placeholder for content that is on its way. A soft gradient band
 * sweeps across a surface-colored block; `prefers-reduced-motion` swaps the
 * sweep for a static block. Size and shape come from the call site via
 * `className` (`h-*`, `w-*`, `rounded-*`).
 *
 * Purely presentational by default. When a skeleton is the only signal that
 * a region is loading, give the wrapper (or a standalone skeleton) the
 * loading semantics: `role="status"` plus an `aria-label`.
 */
export function Skeleton({ as = "div", className, ref, ...rest }: SkeletonProps) {
  return createElement(as, {
    ...rest,
    ref,
    "data-slot": "skeleton",
    className: cn("skeleton-shimmer rounded", className),
  });
}
