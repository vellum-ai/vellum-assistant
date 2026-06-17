import { Suspense, type ReactElement, type ReactNode } from "react";
import * as Sentry from "@sentry/react";

import { isChunkLoadError } from "@/lib/chunk-errors";

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
 * Suspense + ErrorBoundary pair for `React.lazy` components rendered
 * *outside* a route boundary (modals, inline lazy widgets, etc.). For
 * lazy *routes*, React Router's `ErrorBoundary` (see
 * `RouteErrorBoundary`) catches the failure instead.
 *
 * Sentry captures every caught error with `tags.boundary` set to
 * `"lazy-component"` (chunk-fetch failures) or `"component-render"`
 * (genuine render bugs) so they're sliceable separately and
 * symmetric with the `"lazy-route"` / `"route-render"` tagging used
 * by `RouterProvider.onError` for route-level errors.
 *
 * The default error UI matches the inline copy used by
 * `RouteErrorBoundary`'s chunk-fail variant so messaging stays
 * consistent across the app.
 */
export function LazyBoundary({
  children,
  fallback = null,
  errorFallback,
}: LazyBoundaryProps) {
  return (
    <Sentry.ErrorBoundary
      beforeCapture={(scope, error) => {
        scope.setTag(
          "boundary",
          isChunkLoadError(error) ? "lazy-component" : "component-render",
        );
      }}
      fallback={
        errorFallback ?? (
          <div
            role="alert"
            className="p-3 text-body-small-default text-[var(--content-tertiary)]"
          >
            This section couldn&apos;t load. Reload the page to try again.
          </div>
        )
      }
    >
      <Suspense fallback={fallback}>{children}</Suspense>
    </Sentry.ErrorBoundary>
  );
}
