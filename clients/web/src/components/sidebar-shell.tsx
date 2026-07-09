import { ArrowLeft } from "lucide-react";
import { type ReactNode, useCallback, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Button, Typography } from "@vellumai/design-library";

import { RuntimeUpgradeBanner } from "@/components/runtime-upgrade-banner";
import { StatusBanner } from "@/components/status-banner";
import { useEdgeSwipeBack } from "@/hooks/use-edge-swipe-back";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { isElectron } from "@/runtime/is-electron";
import { routes } from "@/utils/routes";

interface SidebarShellProps {
  sidebar: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  backHref: string;
  title?: string;
  menuRoute?: string;
}

/**
 * Sidebar shell — overlay panel treatment.
 *
 * Desktop: one outer card containing sidebar + content side-by-side.
 * Mobile: two-page flow — root shows sidebar, sub-pages show content
 * with a back arrow returning to the root.
 */
export function SidebarShell({
  sidebar,
  children,
  actions,
  backHref,
  title = "Settings",
  menuRoute = routes.settings.root,
}: SidebarShellProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const isMenuRoute = pathname === menuRoute;
  const isMobile = useIsMobile();

  // Edge-swipe back gesture for the mobile two-page flow. It mirrors the
  // header back arrow: from a sub-page it returns to the menu root, and from
  // the menu root it exits to `backHref` (the surface that opened this shell).
  const swipeContainerRef = useRef<HTMLDivElement | null>(null);
  const mobileBackHref = isMenuRoute ? backHref : menuRoute;
  const handleSwipeBack = useCallback(() => {
    navigate(mobileBackHref);
  }, [navigate, mobileBackHref]);
  useEdgeSwipeBack({
    containerRef: swipeContainerRef,
    onBack: handleSwipeBack,
    enabled: isMobile,
    navKey: pathname,
  });

  // In the Electron shell the macOS window controls (traffic lights) sit in an
  // inline title-bar zone at the top of the renderer (see `ChatLayoutHeader` /
  // the desktop app's `MAIN_TRAFFIC_LIGHT_POSITION`). Unlike chat, this shell
  // has no inline header row, so reserve top space to clear the controls AND
  // match the chat layout, whose sidebar/content sits below the 44px title bar
  // plus the 16px content inset (`p-4`) — i.e. 60px (3.75rem) from the top.
  // Off Electron it stays at the standard 1rem inset.
  const electron = isElectron();

  const mobileBackLabel = isMenuRoute
    ? `Back from ${title}`
    : `Back to ${title} menu`;

  const mobileBackButton = (
    <Button
      variant="ghost"
      iconOnly={<ArrowLeft />}
      aria-label={mobileBackLabel}
      tintColor="var(--content-secondary)"
      onClick={() => navigate(mobileBackHref)}
    />
  );

  const desktopBackButton = (
    <Button
      asChild
      variant="outlined"
      aria-label={`Back from ${title}`}
      className="h-8 w-8 px-0"
      tintColor="var(--content-secondary)"
    >
      <Link
        to={backHref}
        className="flex items-center justify-center no-underline"
      >
        <ArrowLeft size={16} aria-hidden="true" />
      </Link>
    </Button>
  );

  return (
    <div
      ref={swipeContainerRef}
      className="flex h-full min-h-0 w-full flex-1 flex-col gap-4 p-4 sm:p-6 md:gap-0"
      style={{
        paddingTop: electron ? "3.75rem" : "1rem",
      }}
    >
      {/* Mobile header */}
      <div className="flex shrink-0 items-center gap-3 md:hidden">
        {mobileBackButton}
        <Typography
          as="h1"
          variant="body-large-default"
          className="flex-1 truncate text-center"
          style={{ color: "var(--content-tertiary)", lineHeight: 1.4 }}
        >
          {title}
        </Typography>
        <div className="h-10 w-10 shrink-0" aria-hidden="true" />
      </div>

      {electron ? (
        <div className="flex shrink-0 flex-col gap-2 pb-4 empty:hidden">
          <StatusBanner placement="electron" className="px-0 pt-0" />
          <RuntimeUpgradeBanner
            placement="electron"
            className="px-0 pt-0"
          />
        </div>
      ) : null}

      {/* Card chrome — desktop only */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:rounded-[12px] md:border md:border-[var(--border-base)] md:bg-[var(--surface-overlay)]">
        {/* Desktop header */}
        <div className="hidden shrink-0 items-center justify-between gap-4 px-6 py-5 md:flex">
          <div className="flex min-w-0 items-center gap-3">
            {desktopBackButton}
            <h1
              className="text-title-large truncate"
              style={{
                color: "var(--content-emphasised)",
                lineHeight: 1.2,
              }}
            >
              {title}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </div>

        {/* Body — sidebar + content */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <aside
            className="hidden w-64 shrink-0 overflow-y-auto md:block"
            aria-label={`${title} navigation`}
          >
            {sidebar}
          </aside>

          {isMenuRoute ? (
            <div className="flex min-w-0 min-h-0 flex-1 flex-col overflow-y-auto pb-6 md:hidden">
              {sidebar}
            </div>
          ) : null}

          <main
            className={`min-w-0 min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-6 md:flex md:px-6 md:pt-0 ${
              isMenuRoute ? "hidden" : "flex"
            }`}
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
