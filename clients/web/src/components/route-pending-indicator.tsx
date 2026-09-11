import { useNavigation } from "react-router";

import { useTranslation } from "@/i18n";

/**
 * A thin bar across the top of the app shell while a route navigation is
 * still resolving.
 *
 * Route components are code split, so a navigation whose chunk is not in the
 * module cache cannot commit until the fetch finishes, and the router holds
 * the outgoing page on screen for the whole wait. With nothing moving, the
 * tap reads as ignored, and the slowest of these is Settings, which resolves
 * two chunks before it will commit.
 *
 * The reveal is delayed in CSS rather than by a timer, so a navigation that
 * resolves inside the delay never paints the bar at all. Nothing here holds
 * state: the bar mounts while the router reports a pending navigation and
 * unmounts when it stops, so it cannot outlive one or miss one.
 */
export function RoutePendingIndicator() {
  const { t } = useTranslation();
  const navigation = useNavigation();

  if (navigation.state === "idle") {
    return null;
  }

  return (
    <div
      data-slot="route-pending-indicator"
      className="route-pending-indicator pointer-events-none absolute inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]"
      role="status"
      aria-label={t("routePendingIndicator.loadingAria")}
    >
      <div className="route-pending-indicator-fill h-full bg-[var(--content-default)]" />
    </div>
  );
}
