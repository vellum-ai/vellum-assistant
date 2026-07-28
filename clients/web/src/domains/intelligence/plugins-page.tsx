import { Navigate, useSearchParams } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Legacy `/assistant/plugins` list URL. The list now lives on the merged
 * My Superpowers page — redirect there, preserving the query params
 * (`?plugin=<name>` still opens the in-tab plugin detail there, and
 * `?success=true` still fires the external-install toast).
 */
export function PluginsPage() {
  const [searchParams] = useSearchParams();
  const search = searchParams.toString();
  return (
    <Navigate
      to={`${routes.superpowers}${search ? `?${search}` : ""}`}
      replace
    />
  );
}
