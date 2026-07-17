import { Navigate, useSearchParams } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Usage moved from the Logs overlay to Settings → Usage. Keep the old route as
 * a permanent redirect so existing bookmarks and schedule deep links
 * (`?scheduleId=…`) continue to reach the same view. The usage view's URL state
 * (`range`, `groupBy`, `scheduleId`) is carried over verbatim; Usage is the
 * default tab on the destination page, so no `tab` param is needed.
 */
export function UsageRedirectPage() {
  const [searchParams] = useSearchParams();

  const query = searchParams.toString();

  return (
    <Navigate replace to={`${routes.settings.usage}${query ? `?${query}` : ""}`} />
  );
}
