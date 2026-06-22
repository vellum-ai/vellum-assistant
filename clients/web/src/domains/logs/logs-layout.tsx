import { useMemo } from "react";
import { Outlet, useLocation } from "react-router";

import { usePlatformGate } from "@/hooks/use-platform-gate";
import { routes } from "@/utils/routes";
import { LOGS_SIDEBAR } from "@/domains/logs/navigation";
import { SidebarShell } from "@/components/sidebar-shell";
import { SidebarTree } from "@/components/sidebar-tree";

export function LogsLayout() {
  const systemEventsGate = usePlatformGate({ platformHostedOnly: true });
  const emailsGate = usePlatformGate();
  const { pathname } = useLocation();

  const filteredItems = useMemo(
    () =>
      LOGS_SIDEBAR.filter((item) => {
        if (item.id === "system-events" && systemEventsGate === "gated") {
          return false;
        }
        if (item.id === "emails" && emailsGate === "gated") {
          return false;
        }
        return true;
      }),
    [systemEventsGate, emailsGate],
  );

  const pageTitle = useMemo(() => {
    const match = LOGS_SIDEBAR.find(
      (item) =>
        pathname === item.href || pathname.startsWith(item.href + "/"),
    );
    if (match) return match.label;
    if (pathname === routes.logs.root) {
      return LOGS_SIDEBAR[0]?.label ?? "Logs & Usage";
    }
    return "Logs & Usage";
  }, [pathname]);

  return (
    <SidebarShell
      backHref={routes.assistant}
      sidebar={<SidebarTree items={filteredItems} indexPath={routes.logs.root} />}
      title={pageTitle}
      menuRoute={routes.logs.root}
    >
      <Outlet />
    </SidebarShell>
  );
}
