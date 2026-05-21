import { useMemo } from "react";
import { Outlet, useLocation } from "react-router";

import { routes } from "@/utils/routes.js";
import { LOGS_SIDEBAR } from "@/domains/logs/navigation.js";
import { SettingsShell } from "@/domains/settings/components/settings-shell.js";
import { SettingsSidebarTree } from "@/domains/settings/components/settings-sidebar-tree.js";

/**
 * React Router layout route for `/assistant/logs/*`.
 *
 * Renders the SettingsShell (full-screen overlay with sidebar navigation)
 * and an `<Outlet />` for the active logs tab page. Uses the same shell
 * component as Settings for visual consistency.
 */
export function LogsLayout() {
  const { pathname } = useLocation();

  const pageTitle = useMemo(() => {
    const match = LOGS_SIDEBAR.find(
      (item) =>
        pathname === item.href || pathname.startsWith(item.href + "/"),
    );
    if (match) return match.label;
    // Index route (/assistant/logs) renders UsagePage but doesn't match
    // any sidebar href — use the first sidebar item's label.
    if (pathname === routes.logs.root) {
      return LOGS_SIDEBAR[0]?.label ?? "Logs & Usage";
    }
    return "Logs & Usage";
  }, [pathname]);

  return (
    <SettingsShell
      backHref={routes.assistant}
      sidebar={<SettingsSidebarTree items={LOGS_SIDEBAR} />}
      title={pageTitle}
      menuRoute={routes.logs.root}
    >
      <Outlet />
    </SettingsShell>
  );
}
