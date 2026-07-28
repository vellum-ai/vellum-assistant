import { useEffect } from "react";
import { Navigate } from "react-router";

import { requiresFullPageNavigation } from "@/domains/account/login-flow";
import { hardNavigate } from "@/lib/auth/hard-navigate";

/**
 * Send an already-signed-in visitor to a sanitized `returnTo` destination.
 *
 * Destinations outside this SPA (absolute URLs, Django routes, the marketing
 * import funnel) need a real page load — routing them through `<Navigate>`
 * would dead-end on the SPA's not-found route.
 */
export function ReturnToRedirect({ to }: { to: string }) {
  const fullPage = requiresFullPageNavigation(to);

  useEffect(() => {
    if (fullPage) hardNavigate(to);
  }, [fullPage, to]);

  if (fullPage) return null;
  return <Navigate to={to} replace />;
}
