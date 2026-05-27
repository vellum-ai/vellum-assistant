import { Loader2, RotateCcw } from "lucide-react";
import * as Sentry from "@sentry/react";
import { useRouteError, isRouteErrorResponse } from "react-router";

import { Button } from "@vellum/design-library/components/button";

/**
 * Returns true if the error looks like a dynamic `import()` failure —
 * stale-deployed chunk, network drop, blocked script, etc. The browser
 * module map caches the rejection for the URL, so an in-app navigation
 * can't retry; only a full reload busts the cache. We detect the
 * common shapes to render a friendlier message and a clearer recovery
 * affordance vs. a generic "Something went wrong."
 */
function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ChunkLoadError") return true;
  const msg = error.message;
  return (
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    msg.includes("error loading dynamically imported module") ||
    msg.includes("Loading chunk")
  );
}

/**
 * Route-level error boundary that catches lazy-chunk load failures and
 * renders an inline message in place of the route's element — leaving
 * the parent layout (sidebar, nav, etc.) visible so the user can
 * navigate elsewhere instead of being trapped on a full-page error.
 *
 * For non-chunk errors (genuine render failures, loader exceptions,
 * 404 route responses), falls back to the existing `RootErrorBoundary`
 * shape (full-page) to avoid burying real bugs in a small banner.
 */
export function LazyRouteErrorBoundary() {
  const error = useRouteError();

  if (isChunkLoadError(error)) {
    // The boundary itself doesn't auto-capture (the wrapped Sentry
    // ErrorBoundary used at component-level does, but at route level
    // RouterProvider's onError handler runs first and reports it). Tag
    // it so it's easy to slice by route-chunk failures in Sentry.
    Sentry.captureException(error, {
      tags: { boundary: "lazy-route" },
    });
    return (
      <div
        data-slot="lazy-route-error-boundary"
        role="alert"
        className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <Loader2
          className="size-6 text-[var(--content-tertiary)]"
          aria-hidden
        />
        <p className="max-w-md text-body-medium-lighter text-[var(--content-secondary)]">
          This section couldn&apos;t load — likely a network blip or a stale
          version. Reload the page to try again.
        </p>
        <Button
          variant="ghost"
          size="compact"
          leftIcon={<RotateCcw />}
          onClick={() => window.location.reload()}
        >
          Reload
        </Button>
      </div>
    );
  }

  // Non-chunk error: defer to the same full-page UI as RootErrorBoundary.
  // Keeping the shape and copy identical avoids two visually-divergent
  // error pages for genuine render bugs vs. RouterProvider-caught errors.
  const status = isRouteErrorResponse(error) ? error.status : undefined;
  const heading = status === 404 ? "Page not found" : "Something went wrong";
  const message =
    status === 404
      ? "The page you requested doesn't exist."
      : "An unexpected error occurred. Try reloading the page.";

  return (
    <div
      data-slot="lazy-route-error-boundary"
      className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <h1 className="text-2xl font-semibold text-[var(--content-primary)]">
        {heading}
      </h1>
      <p className="max-w-md text-[var(--content-secondary)]">{message}</p>
      <Button variant="primary" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}
