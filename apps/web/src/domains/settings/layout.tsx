
import { type ReactNode, useMemo } from "react";

import { useAppPathname } from "@/adapters/app-routing.js";

import { SettingsShell } from "@/components/app/settings/SettingsShell.js";
import { SettingsSidebarTree } from "@/components/app/settings/SettingsSidebarTree.js";
import { useAppFeatureFlags } from "@/lib/feature-flags/feature-flag-provider.js";
import { routes } from "@/lib/routes.js";
import { SETTINGS_SIDEBAR } from "@/lib/settings/navigation.js";

import { SettingsSyncBridge } from "@/domains/settings/_components/settings-sync-bridge.js";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { developerSettings, platformNotifications, sounds } = useAppFeatureFlags();
  const pathname = useAppPathname();

  const filteredItems = useMemo(
    () =>
      SETTINGS_SIDEBAR.filter((item) => {
        if (item.id === "notifications" && !platformNotifications) {
          return false;
        }
        if (item.id === "sounds" && !sounds) {
          return false;
        }
        if (item.id === "developer") {
          return false;
        }
        return true;
      }),
    [platformNotifications, sounds],
  );

  const bottomItems = useMemo(
    () =>
      developerSettings
        ? SETTINGS_SIDEBAR.filter((item) => item.id === "developer")
        : [],
    [developerSettings],
  );

  // Resolve the page title from the current sub-route so the mobile
  // header and desktop card header reflect the active section (e.g.
  // "General", "Integrations"). Falls back to "Settings" on the index
  // route or any path the sidebar doesn't know about. Uses the
  // unfiltered list so flag-gated routes still resolve a label if
  // visited directly.
  const pageTitle = useMemo(() => {
    const match = SETTINGS_SIDEBAR.find(
      (item) =>
        pathname === item.href || pathname.startsWith(item.href + "/"),
    );
    return match?.label ?? "Settings";
  }, [pathname]);

  return (
    <SettingsShell
      backHref={routes.assistant}
      sidebar={
        <SettingsSidebarTree items={filteredItems} bottomItems={bottomItems} />
      }
      title={pageTitle}
    >
      <SettingsSyncBridge />
      {children}
    </SettingsShell>
  );
}
