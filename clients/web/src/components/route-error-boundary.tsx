import { Loader2, RotateCcw } from "lucide-react";
import { isRouteErrorResponse, useRouteError } from "react-router";

import { Button } from "@vellumai/design-library/components/button";

import { isChunkLoadError } from "@/lib/chunk-errors";

/**
 * Single error boundary used at every level of the route tree. Picks
 * one of two variants based on the error shape:
 *
 *   - **Chunk-fetch failures** (stale deploy, network blip, browser
 *     module-map rejection): renders an inline "section couldn't
 *     load" message scoped to the route's content area. Mounted via
 *     pathless wrappers inside layout routes (`RootLayout`,
 *     `ChatLayout`) so the parent chrome stays visible.
 *   - **Anything else** (genuine render error, loader exception,
 *     404 route response): renders the full-page "Something went
 *     wrong" treatment.
 *
 * Sentry capture happens once at `RouterProvider.onError` in
 * `main.tsx`; this boundary only owns the UI. That keeps a single
 * source of truth for tagging (chunk failures get
 * `tags.boundary = "lazy-route"`) and avoids the double-capture you'd
 * get from calling `Sentry.captureException` here too.
 *
 * References:
 *   - https://reactrouter.com/how-to/error-boundary
 *   - https://reactrouter.com/start/data/route-object
 */
export function RouteErrorBoundary() {
  const error = useRouteError();

  if (isChunkLoadError(error)) {
    return (
      <div
        data-slot="route-error-boundary"
        data-variant="chunk-fail"
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

  const status = isRouteErrorResponse(error) ? error.status : undefined;
  const heading = status === 404 ? "Page not found" : "Something went wrong";
  const message =
    status === 404
      ? "The page you requested doesn't exist."
      : "An unexpected error occurred. Try reloading the page.";

  return (
    <div
      data-slot="route-error-boundary"
      data-variant="full-page"
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
