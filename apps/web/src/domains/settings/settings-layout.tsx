import { Loader2 } from "lucide-react";
import { useMemo } from "react";
import { Outlet, useLocation } from "react-router";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { isElectron } from "@/runtime/is-electron";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";
import { SETTINGS_SIDEBAR } from "@/utils/settings-navigation";
import { SidebarShell } from "@/components/sidebar-shell";
import { SidebarTree } from "@/components/sidebar-tree";
import { useSettingsSync } from "@/domains/settings/hooks/use-settings-sync";
import { Typography } from "@vellumai/design-library/components/typography";

/**
 * React Router layout route for `/assistant/settings/*`.
 *
 * Renders the SidebarShell (responsive overlay panel with sidebar
 * navigation) and an `<Outlet />` for the active settings tab page.
 * Also mounts the settings sync bridge to keep TanStack Query caches
 * fresh while the user is on any settings page.
 */
export function SettingsLayout() {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantStateKind = useAssistantLifecycleStore(
    (s) => s.assistantState.kind,
  );
  const settingsDeveloperNav = useAssistantFeatureFlagStore.use.settingsDeveloperNav();
  const platformNotifications = useClientFeatureFlagStore.use.platformNotifications();
  const sounds = useAssistantFeatureFlagStore.use.sounds();
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const billingGate = usePlatformGate();
  const { pathname } = useLocation();

  const filteredItems = useMemo(
    () =>
      SETTINGS_SIDEBAR.filter((item) => {
        if (
          item.id === "notifications" &&
          (!platformNotifications || platformGate === "gated")
        ) {
          return false;
        }
        if (item.id === "billing" && billingGate !== "full") {
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
    [platformNotifications, sounds, platformGate, billingGate],
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
        <SidebarTree items={filteredItems} bottomItems={bottomItems} indexPath={routes.settings.root} />
      }
      title={pageTitle}
    >
      {!assistantId || (assistantStateKind !== "active" && assistantStateKind !== "self_hosted") ? (
        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[var(--app-spacing-md)] text-[var(--content-tertiary)]"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-6 animate-spin" aria-hidden="true" />
          <Typography variant="body-medium-default">
            Connecting to your assistant…
          </Typography>
        </div>
      ) : (
        <Outlet />
      )}
    </SidebarShell>
  );
}
