import { useEffect } from "react";
import { ArrowLeft, ChevronLeft } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router";

import { Button, Typography } from "@vellumai/design-library";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { PageShell } from "@/components/page-shell";
import { useIntelligenceLayoutSlotsStore } from "@/components/layout/intelligence-layout-slots-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslation } from "@/i18n";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import {
  type AboutAssistantSectionKey,
  aboutAssistantSectionForPath,
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
  const { pathname } = useLocation();
  const isMobile = useIsMobile();
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();
  const setMobileTopBar = useChatLayoutSlotsStore.use.setMobileTopBar();
  const headerTrailing = useIntelligenceLayoutSlotsStore.use.headerTrailing();

  const section = aboutAssistantSectionForPath(pathname);
  const sectionTitle = section
    ? t(SECTION_LABEL_KEY[section.key as AboutAssistantSectionKey])
    : null;
  const usesLibraryMobileTopBar = isMobile && section?.key === "library";
  const fallbackAssistantName =
    assistantName || t("identityOverview.defaultAssistantName");
  const backAriaLabel = t("intelligenceLayout.backToAriaLabel", {
    name: fallbackAssistantName,
  });
  const backTitle = t("intelligenceLayout.backToTitle", {
    name: fallbackAssistantName,
  });

  // Library owns the complete mobile top bar so its back, title, and import
  // affordances form one centered navigation row. Other mobile sections keep
  // the shared menu and search chrome and register only their title.
  useEffect(() => {
    if (usesLibraryMobileTopBar && sectionTitle) {
      setTopBarCenter(null);
      setMobileTopBar({
        leading: (
          <Button
            asChild
            variant="ghost"
            iconOnly={<ArrowLeft aria-hidden />}
            aria-label={backAriaLabel}
            tooltip={backTitle}
            className="rounded-full max-md:bg-[var(--surface-active)]"
          >
            <Link to={routes.identity} />
          </Button>
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
    headerTrailing,
    isMobile,
    sectionTitle,
    setMobileTopBar,
    setTopBarCenter,
    usesLibraryMobileTopBar,
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
          that still use the shared app bar. Library's mobile header is fully
          registered above, so it does not render a second body row. */}
      {!usesLibraryMobileTopBar ? (
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
