import { useEffect } from "react";
import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Legacy `/assistant/settings/security` deep links land here; the page's
 * only content (two-factor authentication) now lives on Settings → General.
 */
export function SecurityRedirectPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(routes.settings.general, { replace: true });
  }, [navigate]);

  return null;
}
