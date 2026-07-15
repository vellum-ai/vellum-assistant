import { useEffect } from "react";
import { useNavigate } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Forwards legacy `/assistant/settings/sounds` deep links to the Sounds
 * tab of Settings → Voice & Sounds.
 */
export function SoundsRedirectPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(`${routes.settings.voice}?tab=sounds`, { replace: true });
  }, [navigate]);

  return null;
}
