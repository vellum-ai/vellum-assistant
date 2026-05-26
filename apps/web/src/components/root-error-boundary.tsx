import { useRouteError, isRouteErrorResponse } from "react-router";

import { Button } from "@vellum/design-library/components/button";

/**
 * Root error boundary rendered by React Router when any unhandled error
 * occurs during route resolution (including lazy chunk load failures),
 * loader execution, or component rendering.
 *
 * Uses `useRouteError()` — the React Router v7 data-mode API for
 * accessing the caught error inside an `ErrorBoundary` route property.
 *
 * References:
 * - https://reactrouter.com/how-to/error-boundary
 * - https://reactrouter.com/start/data/route-object
 */
export function RootErrorBoundary() {
  const error = useRouteError();

  const status = isRouteErrorResponse(error) ? error.status : undefined;
  const heading = status === 404 ? "Page not found" : "Something went wrong";
  const message =
    status === 404
      ? "The page you requested doesn't exist."
      : "An unexpected error occurred. Try reloading the page.";

  return (
    <div
      data-slot="root-error-boundary"
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
