import { useEffect } from "react";
import { ChevronLeft } from "lucide-react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";

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

import { MobileTopBarBack, MobileTopBarTitle } from "./mobile-top-bar";

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
 * On a phone the desktop heading row gives way to the mobile top bar this
 * layout registers for every page below the overview, the personality stage
 * included, so one owner draws the back control and no page below draws its
 * own.
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
  const isWorkspace = section?.key === "workspace";
  const sectionTitle = section ? t(SECTION_LABEL_KEY[section.key]) : null;
  /**
   * The bar's title, and the test for whether a page takes the bar at all.
   * The personality stage is no section, but it is one drill-down below the
   * overview, so on a phone it wears the same bar under the label the
   * overview card sent the user in by. The overview itself is the root and
   * wears none.
   */
  const mobileTopBarTitle =
    sectionTitle ??
    (isPathExactly(pathname, routes.personality)
      ? t("identitySections.personality.label")
      : null);
  // On a phone every page below the overview owns the complete top bar (back,
  // title, action), so those affordances form one centered navigation row and
  // nothing below draws a second back control. The body heading row is
  // desktop-only.
  const ownsMobileTopBar = isMobile && mobileTopBarTitle != null;
  /**
   * The list the Back pill returns to, else null for the overview. The page
   * reports whether its detail is a pushed screen, since the pane it measures
   * can still seat the list beside the detail on a mobile-width window. The
   * path has to agree: on the list itself a Back to the list would point at
   * the page already on screen, whoever set the flag and whenever.
   */
  const backToListPath =
    ownsMobileTopBar &&
    detailIsScreen &&
    section != null &&
    !isPathExactly(pathname, section.to)
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
    if (ownsMobileTopBar && mobileTopBarTitle) {
      const destination =
        backToListPath != null
          ? {
              ariaLabel: t("intelligenceLayout.backToAriaLabel", {
                name: mobileTopBarTitle,
              }),
              tooltip: t("intelligenceLayout.backToTitle", {
                name: mobileTopBarTitle,
              }),
              onClick: () => returnToList(navigate, state, backToListPath),
            }
          : {
              ariaLabel: backAriaLabel,
              tooltip: backTitle,
              to: routes.identity,
            };
      setTopBarCenter(null);
      setMobileTopBar({
        leading: <MobileTopBarBack {...destination} />,
        center: isWorkspace ? (
          <span data-slot="workspace-page-title" className="flex min-w-0">
            <MobileTopBarTitle className="text-[var(--content-default)] [--text-body-medium-default-size:17px] [--text-body-medium-default-weight:600]">
              {mobileTopBarTitle}
            </MobileTopBarTitle>
          </span>
        ) : (
          <MobileTopBarTitle>{mobileTopBarTitle}</MobileTopBarTitle>
        ),
        trailing: headerTrailing,
      });
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
    isWorkspace,
    mobileTopBarTitle,
    navigate,
    ownsMobileTopBar,
    setMobileTopBar,
    setTopBarCenter,
    state,
    t,
  ]);

  // The overview and personality pages paint their own full-bleed stage, so
  // they take no shell and no body chrome. Personality still takes the mobile
  // top bar registered above; the overview is the root and takes none.
  if (!section) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </div>
    );
  }

  return (
    <PageShell
      className={
        isWorkspace
          ? "max-md:rounded-none max-md:border-0 max-md:px-3.5 max-md:pt-0 max-md:pb-3.5"
          : undefined
      }
      style={
        isWorkspace
          ? { backgroundColor: "var(--surface-base)" }
          : undefined
      }
    >
      {/* Desktop section chrome. A phone gets these affordances from the
          mobile top bar registered above, so this row would be a second back
          control and does not render there. */}
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
          <h1 className="text-title-large text-[var(--content-default)]">
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
