import { useEffect, useRef } from "react";

import { isNativePlatform } from "@/runtime/native-auth";
import { isVellumDomain } from "@/utils/domains";

/** Platform route that appends to the marketing page-view ledger. */
const FUNNEL_BEACON_ENDPOINT = "/api/funnel/view";

/**
 * Report that a visitor reached an SPA-served auth page.
 *
 * The marketing page-view ledger is written by the platform's Next.js
 * middleware, but `/account/*` is routed to the static SPA by ingress and
 * served by nginx from this bundle, so that middleware never runs for these
 * routes. Without this beacon the funnel is dark between the marketing landing
 * page and the created user, and campaign drop-off can't be pinned to either
 * the landing page or the signup step.
 *
 * The visitor id lives in the `HttpOnly` `vellum_vid` cookie, which this app
 * cannot read. The beacon therefore reports only *which* page was reached and
 * lets the platform resolve the visitor server-side from the cookie it can
 * see — which is also why this is a same-origin request rather than a log line.
 */
export function useFunnelPageView(path: string, enabled: boolean): void {
  const reportedPath = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    // Guards React's double-invoked effects in development, and any re-render
    // that doesn't change `path` — one arrival should be one ledger entry.
    if (reportedPath.current === path) {
      return;
    }
    // Native signups are a separate funnel and resolve against a different
    // origin. Off a vellum.ai host (self-hosted, local dev) the endpoint
    // doesn't exist, so skip rather than fire a request that always fails.
    if (isNativePlatform()) {
      return;
    }
    if (!isVellumDomain(window.location.hostname)) {
      return;
    }

    reportedPath.current = path;

    void fetch(FUNNEL_BEACON_ENDPOINT, {
      method: "POST",
      // The platform resolves `vellum_vid` from the request cookies.
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
      // The next click leaves for the OAuth provider; without this the
      // in-flight beacon is cancelled on navigation and the arrival is lost.
      keepalive: true,
    }).catch(() => {
      // Telemetry must never surface to the user or break the auth screen.
    });
  }, [path, enabled]);
}
