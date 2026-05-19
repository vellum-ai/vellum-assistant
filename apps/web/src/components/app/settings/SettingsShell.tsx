import type { Route } from "@/types/route.js";

import { ArrowLeft } from "lucide-react";
import { AppLink as Link } from "@/adapters/app-link.js";
import { useLocation, useNavigate } from "react-router";
import { type ReactNode } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Typography } from "@vellum/design-library/components/typography";
import { AssistantShell as Layout } from "@/components/shell/assistant-shell.js";
import { routes } from "@/lib/routes.js";

interface SettingsShellProps {
  /** Sidebar nav (e.g. `SettingsSidebarTree`). */
  sidebar: ReactNode;
  /** Main settings content. */
  children: ReactNode;
  /**
   * Optional trailing-edge action(s) for the panel header — typically a
   * `Reset to Defaults` button. Per Figma node 2674:18074 this slot lives
   * on the right of the title row.
   */
  actions?: ReactNode;
  /** Route the back arrow navigates to (out of the panel entirely). */
  backHref: Route;
  /** Panel heading text. Defaults to "Settings". */
  title?: string;
  /**
   * Route considered the "menu" route — the root of this overlay panel.
   * On mobile, the menu page renders the sidebar full-screen; sub-routes
   * render the content with a back arrow that returns to this route.
   * Defaults to `routes.settings.root` so existing settings callers
   * keep working unchanged.
   */
  menuRoute?: Route;
}

/**
 * Settings shell — the "Overlay Panel" treatment from Figma node
 * 2674:18074 on desktop, and Figma nodes 2880:11030 / 2883:11205 on
 * mobile.
 *
 * Desktop layout — one outer card on a `--surface-overlay` surface
 * containing:
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │ ← Settings                          {actions}        │
 *   ├─────────────────┬───────────────────────────────────┤
 *   │ Sidebar nav     │ Page content cards                 │
 *   │ (Account, …)    │                                    │
 *   └─────────────────┴───────────────────────────────────┘
 *
 * Bypasses the global app header (Vellum logo / org / user menu) — that
 * chrome is suppressed via `Layout`'s `hideHeader` prop.
 *
 * On viewports narrower than `md` settings is a true two-page flow with
 * native browser back navigation:
 *
 *   - `/assistant/settings`         → menu page (sidebar full-screen)
 *                                     back arrow → `backHref` (assistant)
 *   - `/assistant/settings/<sub>`   → content page (children full-screen)
 *                                     back arrow → `/assistant/settings` (menu)
 */
export function SettingsShell({
  sidebar,
  children,
  actions,
  backHref,
  title = "Settings",
  menuRoute = routes.settings.root,
}: SettingsShellProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const isMenuRoute = pathname === menuRoute;

  // Mobile back arrow: from a sub-page returns to the menu; from the
  // menu page exits the panel entirely. Uses the round-pill ghost
  // icon-only button so it matches the chat-header burger button at
  // 40×40 on mobile. (asChild + Link doesn't compose with iconOnly —
  // Slot would replace the Link with the icon span — so we navigate
  // imperatively instead.)
  const mobileBackHref: Route = isMenuRoute ? backHref : menuRoute;
  const mobileBackLabel = isMenuRoute
    ? `Back from ${title}`
    : "Back to settings menu";

  const mobileBackButton = (
    <Button
      variant="ghost"
      iconOnly={<ArrowLeft />}
      aria-label={mobileBackLabel}
      tintColor="var(--content-secondary)"
      onClick={() => navigate(mobileBackHref)}
    />
  );

  // Desktop back button — exits settings entirely. Kept as the
  // outlined square spec from Figma 2674:18074 (40px chip).
  const desktopBackButton = (
    <Button
      asChild
      variant="outlined"
      aria-label={`Back from ${title}`}
      className="h-8 w-8 px-0"
      tintColor="var(--content-secondary)"
    >
      <Link
        href={backHref}
        className="flex items-center justify-center no-underline"
      >
        <ArrowLeft size={16} aria-hidden="true" />
      </Link>
    </Button>
  );

  // Mobile header title swaps with the route: the menu page reads
  // "Settings"; sub-pages read the section name (e.g. "General").
  const mobileTitle = isMenuRoute ? "Settings" : title;

  return (
    <Layout>
      <div className="flex h-full min-h-0 w-full flex-1 flex-col gap-4 p-4 sm:p-6 md:gap-0">
        {/* Mobile header — sits ABOVE the panel on the page background.
            Symmetric trailing spacer keeps the title optically centered. */}
        <div className="flex shrink-0 items-center gap-3 md:hidden">
          {mobileBackButton}
          <Typography
            as="h1"
            variant="body-large-default"
            className="flex-1 truncate text-center"
            // body-large-default bakes in line-height: 1, which can clip
            // descenders/ascenders depending on the font fallback. Loosen
            // locally to leave breathing room without changing the token.
            style={{ color: "var(--content-tertiary)", lineHeight: 1.4 }}
          >
            {mobileTitle}
          </Typography>
          <div className="h-10 w-10 shrink-0" aria-hidden="true" />
        </div>

        {/* The rounded card chrome (border + surface-overlay bg) is
            desktop-only. On mobile the page content cards float
            directly on the page background. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:rounded-[12px] md:border md:border-[var(--border-base)] md:bg-[var(--surface-overlay)]">
          {/* Desktop header — back + title (left), actions slot (right). */}
          <div className="hidden shrink-0 items-center justify-between gap-4 px-6 py-5 md:flex">
            <div className="flex min-w-0 items-center gap-3">
              {desktopBackButton}
              <h1
                className="text-title-large truncate"
                // text-title-large bakes in line-height: 1 (per Figma spec)
                // which clips descenders ("g" in "Settings"). Loosen the
                // line-height locally to leave room for the descender
                // without changing the canonical token.
                style={{
                  color: "var(--content-emphasised)",
                  lineHeight: 1.2,
                }}
              >
                {title}
              </h1>
            </div>
            {actions ? (
              <div className="flex shrink-0 items-center gap-2">{actions}</div>
            ) : null}
          </div>

          {/* Body — sidebar + content. On desktop this is the standard
              two-pane layout. On mobile it's one-or-the-other based on
              the route: the menu page renders the sidebar full-width,
              every other page renders just the content. */}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <aside
              className="hidden w-64 shrink-0 overflow-y-auto md:block"
              aria-label="Settings navigation"
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
    </Layout>
  );
}
