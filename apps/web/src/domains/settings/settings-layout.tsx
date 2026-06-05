import { useMemo } from "react";
import { Outlet, useLocation } from "react-router";

import { usePlatformGate } from "@/hooks/use-platform-gate";
import { isElectron } from "@/runtime/is-electron";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";
import { SETTINGS_SIDEBAR } from "@/utils/settings-navigation";
import { SidebarShell } from "@/components/sidebar-shell";
import { SidebarTree } from "@/components/sidebar-tree";
import { useSettingsSync } from "@/domains/settings/hooks/use-settings-sync";

/**
 * React Router layout route for `/assistant/settings/*`.
 *
 * Renders the SidebarShell (responsive overlay panel with sidebar
 * navigation) and an `<Outlet />` for the active settings tab page.
 * Also mounts the settings sync bridge to keep TanStack Query caches
 * fresh while the user is on any settings page.
 */
export function SettingsLayout() {
  const settingsDeveloperNav = useAssistantFeatureFlagStore.use.settingsDeveloperNav();
  const platformNotifications = useClientFeatureFlagStore.use.platformNotifications();
  const sounds = useAssistantFeatureFlagStore.use.sounds();
  // platformHostedOnly so the sidebar filter fires on self-hosted active
  // assistants (lifecycle `kind: "self_hosted"` OR `kind: "active",
  // isLocal: true`) — not just on local-mode-with-features-off, which is
  // what the standard gate's `"gated"` state means.
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const { pathname } = useLocation();

  const filteredItems = useMemo(
    () =>
      SETTINGS_SIDEBAR.filter((item) => {
        // Notifications and billing are both organization-scoped platform
        // concepts. Hide the sidebar items entirely when the active assistant
        // is self-hosted so users don't land on an empty page. Each page
        // also redirects to `routes.settings.general` for the same gate, as
        // defense in depth for direct URL / bookmark navigation.
        if (
          item.id === "notifications" &&
          (!platformNotifications || platformGate === "gated")
        ) {
          return false;
        }
        if (item.id === "billing" && platformGate === "gated") {
          return false;
        }
        if (item.id === "devices" && platformGate === "gated") {
          return false;
        }
        if (item.id === "sounds" && !sounds) {
          return false;
        }
        // Hotkey rebinding drives Electron globalShortcut + menu accelerators,
        // which have no web/iOS analogue. Hide the entry off the desktop app;
        // the page itself also redirects as defense in depth.
        if (item.id === "keyboard-shortcuts" && !isElectron()) {
          return false;
        }
        if (item.id === "developer") {
          return false;
        }
        return true;
      }),
    [platformNotifications, sounds, platformGate],
  );

  const bottomItems = useMemo(
    () =>
      settingsDeveloperNav
        ? SETTINGS_SIDEBAR.filter((item) => item.id === "developer")
        : [],
    [settingsDeveloperNav],
  );

  const pageTitle = useMemo(() => {
    if (pathname === routes.settings.root) return "Settings";
    const match = SETTINGS_SIDEBAR.find(
      (item) =>
        pathname === item.href || pathname.startsWith(item.href + "/"),
    );
    if (match) return match.label;
    return "Settings";
  }, [pathname]);

  useSettingsSync();

  return (
    <SidebarShell
      backHref={routes.assistant}
      sidebar={
        <SidebarTree items={filteredItems} bottomItems={bottomItems} />
      }
      title={pageTitle}
    >
      <Outlet />
    </SidebarShell>
  );
}
