import { LogIn, LogOut } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";

import { useTranslation } from "@/i18n";
import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { handleLogout } from "@/lib/auth/handle-logout";
import { useCanUseInternalThreadActions } from "@/lib/auth/internal-thread-actions";
import { useSupportsBookmarks } from "@/lib/backwards-compat/use-supports-bookmarks";
import { useSupportsCredentialsSettings } from "@/lib/backwards-compat/use-supports-credentials-settings";
import { useIsNativeAndroid } from "@/runtime/platform-detection";
import { useHasPlatformSession } from "@/stores/auth-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useTitleBarStore } from "@/stores/title-bar-store";
import { routes } from "@/utils/routes";
import { SETTINGS_SIDEBAR } from "@/utils/settings-navigation";
import { SidebarShell } from "@/components/sidebar-shell";
import { SidebarTree, type SidebarItem } from "@/components/sidebar-tree";

/**
 * React Router layout route for `/assistant/settings/*`.
 *
 * Renders the SidebarShell (responsive overlay panel with sidebar
 * navigation) and an `<Outlet />` for the active settings tab page.
 */
export function SettingsLayout() {
  const settingsDeveloperNav =
    useAssistantFeatureFlagStore.use.settingsDeveloperNav();
  // Settings brings its own full-screen chrome; the Windows in-title-bar
  // menu bar yields while it's up (inert off the Windows shell, where the
  // menu bar doesn't render anyway).
  const setWindowsMenuBarSuppressed =
    useTitleBarStore.use.setWindowsMenuBarSuppressed();
  useEffect(() => {
    setWindowsMenuBarSuppressed(true);
    return () => setWindowsMenuBarSuppressed(false);
  }, [setWindowsMenuBarSuppressed]);
  const { t } = useTranslation("settings");
  const isNativeAndroid = useIsNativeAndroid();
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  // The Bookmarks and Credentials tabs need routes that only newer assistants
  // serve (v0.8.1+ / v0.10.8+); an older assistant 404s them, so hide the
  // tabs rather than render a dead error page. Scoped to the active assistant
  // so a stale cross-store version can't light a tab mid-switch.
  const supportsBookmarks = useSupportsBookmarks(activeAssistantId);
  const supportsCredentials = useSupportsCredentialsSettings(activeAssistantId);
  // Bookmarks are internal-only, behind the same gate as the fork and
  // inspector affordances. Hides the tab rather than leaving a route whose
  // only content-producing affordance (the per-message toggle) is hidden.
  const canUseInternalActions = useCanUseInternalThreadActions();
  // The Usage item is never hidden: the Usage tab reads from the local daemon
  // and works for every assistant. Its label only gains "Billing &" when the
  // Billing tab is actually shown — i.e. signed in to the Vellum platform
  // (`usePlatformGate() === "full"`), matching billing-page.tsx's
  // `showBillingTab`. Signed-out / self-hosted users see just "Usage".
  const billingGate = usePlatformGate();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // Show Log Out when a platform session exists, Log In otherwise.
  const hasPlatformSession = useHasPlatformSession();
  const { login } = useOnboardingLogin();

  const getSidebarLabel = useCallback(
    (id: string, defaultLabel: string) => {
      switch (id) {
        case "assistant-status":
          return t("sidebar.general", "General");
        case "model":
          return t("sidebar.model", "Models & Services");
        case "integrations":
          return t("sidebar.integrations", "Integrations");
        case "credentials":
          return t("sidebar.credentials", "Credentials");
        case "notifications":
          return t("sidebar.notifications", "Notifications");
        case "voice":
          return t("sidebar.voice", "Voice");
        case "sounds":
          return t("sidebar.sounds", "Sounds");
        case "privacy":
          return t("sidebar.privacy", "Permissions & Privacy");
        case "bookmarks":
          return t("sidebar.bookmarks", "Bookmarks");
        case "billing":
          return billingGate === "full"
            ? t("sidebar.billingUsage", "Billing & Usage")
            : t("sidebar.usage", "Usage");
        case "community":
          return t("sidebar.community", "Community");
        case "debug":
          return t("sidebar.debug", "Debug");
        case "developer":
          return t("sidebar.developer", "Developer");
        default:
          return defaultLabel;
      }
    },
    [t, billingGate],
  );

  const filteredItems = useMemo(
    () =>
      SETTINGS_SIDEBAR.filter((item) => {
        if (item.id === "notifications" && !isNativeAndroid) {
          return false;
        }
        if (
          item.id === "bookmarks" &&
          (!supportsBookmarks || !canUseInternalActions)
        ) {
          return false;
        }
        if (item.id === "credentials" && !supportsCredentials) {
          return false;
        }
        if (item.id === "developer") {
          return false;
        }
        return true;
      }).map((item) => ({
        ...item,
        label: getSidebarLabel(item.id, item.label),
      })),
    [
      isNativeAndroid,
      supportsBookmarks,
      canUseInternalActions,
      supportsCredentials,
      getSidebarLabel,
    ],
  );

  const bottomItems = useMemo<SidebarItem[]>(() => {
    const items: SidebarItem[] = [];
    if (settingsDeveloperNav) {
      items.push(
        ...SETTINGS_SIDEBAR.filter((item) => item.id === "developer").map(
          (item) => ({
            ...item,
            label: getSidebarLabel(item.id, item.label),
          }),
        ),
      );
    }
    // The auth action is pinned to the very bottom of the nav.
    items.push(
      hasPlatformSession
        ? {
            id: "logout",
            label: t("sidebar.logout", "Log Out"),
            icon: LogOut,
            onSelect: () => void handleLogout(navigate),
          }
        : {
            id: "login",
            label: t("sidebar.login", "Log In"),
            icon: LogIn,
            onSelect: () => void login(),
          },
    );
    return items;
  }, [
    settingsDeveloperNav,
    hasPlatformSession,
    navigate,
    login,
    t,
    getSidebarLabel,
  ]);

  const pageTitle = useMemo(() => {
    if (pathname === routes.settings.root) {
      return t("sidebar.title", "Settings");
    }
    const match = SETTINGS_SIDEBAR.find(
      (item) => pathname === item.href || pathname.startsWith(item.href + "/"),
    );
    if (match) {
      return getSidebarLabel(match.id, match.label);
    }
    return t("sidebar.title", "Settings");
  }, [pathname, t, getSidebarLabel]);

  return (
    <SidebarShell
      backHref={routes.assistant}
      sidebar={
        <SidebarTree
          items={filteredItems}
          bottomItems={bottomItems}
          indexPath={routes.settings.root}
        />
      }
      title={pageTitle}
    >
      <Outlet />
    </SidebarShell>
  );
}
