import { Suspense, type ReactElement, type ReactNode } from "react";
import * as Sentry from "@sentry/react";

interface LazyBoundaryProps {
  children: ReactNode;
  /** Rendered while the lazy chunk is loading. */
  fallback?: ReactNode;
  /**
   * Rendered when the lazy chunk fails to load (e.g. network drop between
   * the user triggering the lazy component and the chunk arriving). The
   * default message instructs the user to reload — React.lazy memoizes
   * rejected import promises at the module level, so an inline retry would
   * not actually re-fetch; full reload is the realistic remediation.
   *
   * Pass an alternate `errorFallback` for graceful degradation (e.g. a
   * weather card showing the markdown body when the rich chart chunk
   * fails to arrive). Must be a `ReactElement` (wrap bare strings in a
   * `<span>`/`<div>`).
   */
  errorFallback?: ReactElement;
}

/**
 * Suspense + ErrorBoundary pair for `React.lazy` components. Catches chunk
 * load failures (which otherwise hang on Suspense forever or escape to the
 * route's `ErrorBoundary` and nuke the whole route) and reports them to
 * Sentry. Use this anywhere `React.lazy` is rendered outside a route
 * boundary.
 */
export function LazyBoundary({
  children,
  fallback = null,
  errorFallback,
}: LazyBoundaryProps) {
  return (
    <Sentry.ErrorBoundary
      fallback={
        errorFallback ?? (
          <div
            role="alert"
            className="p-3 text-body-small-default text-[var(--content-tertiary)]"
          >
            Failed to load this view. Please reload the page.
          </div>
        )
      }
    >
      <Suspense fallback={fallback}>{children}</Suspense>
    </Sentry.ErrorBoundary>
  );
}
