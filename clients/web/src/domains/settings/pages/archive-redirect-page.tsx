import { useEffect } from "react";
import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Legacy `/assistant/settings/archive` deep links land here; the page's
 * content now lives on Settings → Advanced under the Archive tab.
 */
export function ArchiveRedirectPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(routes.settings.advanced, { replace: true });
  }, [navigate]);

  return null;
}
