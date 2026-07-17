import { Navigate, useSearchParams } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Usage moved from the Logs overlay to Settings → Billing & Usage. Keep the
 * old route as a permanent redirect so existing bookmarks and schedule deep
 * links (`?scheduleId=…`) continue to reach the same view. The usage view's
 * URL state (`range`, `groupBy`, `scheduleId`) is carried over verbatim.
 */
export function UsageRedirectPage() {
  const [searchParams] = useSearchParams();

  const params = new URLSearchParams(searchParams);
  params.set("tab", "usage");

  return (
    <Navigate replace to={`${routes.settings.billing}?${params.toString()}`} />
  );
}
