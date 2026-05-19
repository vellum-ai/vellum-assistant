
import { useLocation } from "react-router";
import { type ReactNode, useMemo } from "react";

import { SettingsShell } from "@/components/app/settings/SettingsShell.js";
import { SettingsSidebarTree } from "@/components/app/settings/SettingsSidebarTree.js";
import { LOGS_SIDEBAR } from "@/lib/logs/navigation.js";
import { routes } from "@/lib/routes.js";

export default function LogsLayout({ children }: { children: ReactNode }) {
  const { pathname: pathname } = useLocation();

  // Resolve the page title from the active sub-route so the mobile
  // header and desktop card header reflect the current section
  // ("Logs", "Usage", "System Events"). Falls back to "Logs & Usage"
  // on the index route or any path the sidebar doesn't know about.
  const pageTitle = useMemo(() => {
    const match = LOGS_SIDEBAR.find(
      (item) =>
        pathname === item.href || pathname.startsWith(item.href + "/"),
    );
    return match?.label ?? "Logs & Usage";
  }, [pathname]);

  return (
    <SettingsShell
      backHref={routes.assistant}
      menuRoute={routes.logs.root}
      sidebar={<SettingsSidebarTree items={LOGS_SIDEBAR} />}
      title={pageTitle}
    >
      {children}
    </SettingsShell>
  );
}
