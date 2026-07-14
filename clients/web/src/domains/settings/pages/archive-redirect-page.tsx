import { useEffect } from "react";
import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Forwards legacy `/assistant/settings/archive` deep links to
 * Settings → Advanced, which hosts the Archive tab.
 */
export function ArchiveRedirectPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(routes.settings.advanced, { replace: true });
  }, [navigate]);

  return null;
}
