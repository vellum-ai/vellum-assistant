import { useEffect } from "react";
import { ArrowLeft, ChevronLeft } from "lucide-react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";

import { Button, Typography } from "@vellumai/design-library";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { PageShell } from "@/components/page-shell";
import { useIntelligenceLayoutSlotsStore } from "@/components/layout/intelligence-layout-slots-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslation } from "@/i18n";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { returnToList } from "@/utils/list-detail-navigation";
import {
  type AboutAssistantSectionKey,
  aboutAssistantSectionForPath,
  isPathExactly,
  routes,
} from "@/utils/routes";

/**
 * Greppable overview section titles shown in the layout's header (and
 * mobile top bar). `plugins`/`skills` share the "My Superpowers" section
 * with `superpowers` (see `ABOUT_ASSISTANT_SECTIONS` in `utils/routes.ts`).
 */
const SECTION_LABEL_KEY: Record<
  AboutAssistantSectionKey,
  `sections.${"schedules" | "superpowers" | "memory" | "library" | "workspace" | "contacts" | "channels"}`
> = {
  schedules: "sections.schedules",
  superpowers: "sections.superpowers",
  plugins: "sections.superpowers",
  skills: "sections.superpowers",
  memory: "sections.memory",
  library: "sections.library",
  workspace: "sections.workspace",
  contacts: "sections.contacts",
  channels: "sections.channels",
};

/**
 * Shared layout for the "About Assistant" pages. The overview
 * (`/assistant/identity`) and the personality page render full-bleed —
 * they own their avatar-tinted stage chrome — while every other section
 * (Schedules, My Superpowers, Memory, Workspace, Contacts, Channels,
 * Library) renders inside the standard page shell with a back button to the
 * overview where the old tab bar used to be. The section registry lives in
 * `utils/routes.ts` (`ABOUT_ASSISTANT_SECTIONS`) — shared with the
 * sidebar's active-section highlight and the overview strip.
 *
 * Mounted as a pathless layout route in `routes.tsx` so the child routes
 * keep their existing URL paths (`/assistant/identity`, etc.) while
 * inheriting the shared chrome.
 *
 * @see https://reactrouter.com/start/framework/routing#layout-routes
 */
export function IntelligenceLayout() {
  const { t } = useTranslation("intelligence");
  const assistantName = useAssistantIdentityStore.use.name();
  const { pathname, state } = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();
  const setMobileTopBar = useChatLayoutSlotsStore.use.setMobileTopBar();
  const headerTrailing = useIntelligenceLayoutSlotsStore.use.headerTrailing();
  const detailIsScreen = useIntelligenceLayoutSlotsStore.use.detailIsScreen();

  const section = aboutAssistantSectionForPath(pathname);
  const sectionTitle = section ? t(SECTION_LABEL_KEY[section.key]) : null;
  // Library and Contacts own the complete mobile top bar (back, title, action)
  // so those affordances form one centered navigation row; every other section
  // registers only its title into the shared app bar.
  const ownsMobileTopBar =
    isMobile && (section?.key === "library" || section?.key === "contacts");
  /**
   * The list the Back pill returns to, else null for the overview. The page
   * reports whether its detail is a pushed screen, since the pane it measures
   * can still seat the list beside the detail on a mobile-width window. The
   * path has to agree: on the list itself a Back to the list would point at
   * the page already on screen, whoever set the flag and whenever.
   */
  const backToListPath =
    ownsMobileTopBar && detailIsScreen && !isPathExactly(pathname, section.to)
      ? section.to
      : null;
  const fallbackAssistantName =
    assistantName || t("identityOverview.defaultAssistantName");
  const backAriaLabel = t("intelligenceLayout.backToAriaLabel", {
    name: fallbackAssistantName,
  });
  const backTitle = t("intelligenceLayout.backToTitle", {
    name: fallbackAssistantName,
  });

  useEffect(() => {
    if (ownsMobileTopBar && sectionTitle) {
      // A plain button for the list, so nothing navigates before
      // `returnToList` decides between popping and replacing; a link for the
      // overview, which is a plain destination.
      const destination =
        backToListPath != null
          ? {
              "aria-label": t("intelligenceLayout.backToAriaLabel", {
                name: sectionTitle,
              }),
              tooltip: t("intelligenceLayout.backToTitle", {
                name: sectionTitle,
              }),
              onClick: () => returnToList(navigate, state, backToListPath),
            }
          : {
              "aria-label": backAriaLabel,
              tooltip: backTitle,
              asChild: true,
              children: <Link to={routes.identity} />,
            };
      setTopBarCenter(null);
      setMobileTopBar({
        leading: (
          <Button
            shape="pill"
            variant="ghost"
            iconOnly={<ArrowLeft aria-hidden />}
            className="max-md:bg-[var(--surface-active)]"
            {...destination}
          />
        ),
        center: (
          <Typography
            variant="body-medium-default"
            className="max-w-[50vw] truncate text-[var(--content-secondary)]"
          >
            {sectionTitle}
          </Typography>
        ),
        trailing: headerTrailing,
      });
    } else if (isMobile && sectionTitle) {
      setMobileTopBar(null);
      setTopBarCenter(
        <Typography
          variant="body-medium-default"
          className="truncate text-[var(--content-secondary)]"
        >
          {sectionTitle}
        </Typography>,
      );
    } else {
      setMobileTopBar(null);
      setTopBarCenter(null);
    }
    return () => {
      setMobileTopBar(null);
      setTopBarCenter(null);
    };
  }, [
    backAriaLabel,
    backTitle,
    backToListPath,
    headerTrailing,
    isMobile,
    navigate,
    ownsMobileTopBar,
    sectionTitle,
    setMobileTopBar,
    setTopBarCenter,
    state,
    t,
  ]);

  // The overview and personality pages paint their own full-bleed stage —
  // no shell, heading, or back chrome.
  if (!section) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </div>
    );
  }

  return (
    <PageShell>
      {/* Desktop section chrome and the existing mobile chrome for sections
          that still use the shared app bar. The sections that own the mobile
          top bar register it above, so they do not render a second body row. */}
      {!ownsMobileTopBar ? (
        <div className="mb-4 flex shrink-0 items-center gap-1.5">
          <Link
            to={routes.identity}
            className="-ml-2 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--content-secondary)] transition-colors outline-none hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            aria-label={backAriaLabel}
            title={backTitle}
          >
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </Link>
          <h1 className="text-title-large text-[var(--content-default)] max-md:hidden">
            {sectionTitle}
          </h1>
          {headerTrailing ? (
            <div className="ml-auto flex shrink-0 items-center">
              {headerTrailing}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Outlet />
      </div>
    </PageShell>
  );
}
