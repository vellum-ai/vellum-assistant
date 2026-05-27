import { useMemo } from "react";
import { Outlet, useLocation } from "react-router";

import { routes } from "@/utils/routes";
import { LOGS_SIDEBAR } from "@/domains/logs/navigation";
import { SidebarShell } from "@/components/sidebar-shell";
import { SidebarTree } from "@/components/sidebar-tree";

/**
 * React Router layout route for `/assistant/logs/*`.
 *
 * Renders the SidebarShell (full-screen overlay with sidebar navigation)
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
    <SidebarShell
      backHref={routes.assistant}
      sidebar={<SidebarTree items={LOGS_SIDEBAR} />}
      title={pageTitle}
      menuRoute={routes.logs.root}
    >
      <Outlet />
    </SidebarShell>
  );
}
