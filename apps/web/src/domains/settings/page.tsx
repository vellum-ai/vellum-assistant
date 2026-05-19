
import { useEffect } from "react";

import { useAppNavigate } from "@/adapters/app-routing.js";
import { routes } from "@/lib/routes.js";

/**
 * Settings index. On mobile this resolves to the settings menu (rendered
 * by `SettingsShell` based on the pathname); on desktop, where the menu
 * lives in the persistent sidebar, we forward to the General sub-page so
 * the content area is never empty.
 */
export default function SettingsPage() {
  const { replace } = useAppNavigate();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(min-width: 768px)").matches) {
      replace(routes.settings.general);
    }
  }, [replace]);

  return null;
}
