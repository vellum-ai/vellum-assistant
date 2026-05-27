import { Loader2 } from "lucide-react";

/**
 * Rendered by React Router during initial hydration while the matched
 * route's lazy chunk is loading. Without this, the router logs a
 * `No HydrateFallback element provided…` warning and renders `null`
 * (blank screen) during the brief async resolution window.
 *
 * Reference: https://reactrouter.com/start/data/route-object#hydratefallback
 */
export function RootHydrateFallback() {
  return (
    <div
      data-slot="root-hydrate-fallback"
      className="flex min-h-svh items-center justify-center"
      role="status"
      aria-label="Loading"
    >
      <Loader2 className="size-6 animate-spin text-[var(--content-tertiary)]" />
    </div>
  );
}
