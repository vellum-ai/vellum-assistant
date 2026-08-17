import { useEffect } from "react";
import { ChevronLeft } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router";

import { Typography } from "@vellumai/design-library";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { PageShell } from "@/components/page-shell";
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

  const section = aboutAssistantSectionForPath(pathname);
  const sectionTitle = section
    ? t(SECTION_LABEL_KEY[section.key as AboutAssistantSectionKey])
    : null;

  // On mobile the section title moves out of the page body and into the
  // shared top bar — centered between the hamburger menu and the search
  // icon. The bare pages (overview, personality) set no title: the
  // greeting on the stage already names the assistant. Desktop keeps the
  // in-body <h1> (section pages only) and leaves the top-bar center empty.
  useEffect(() => {
    if (isMobile && sectionTitle) {
      setTopBarCenter(
        <Typography
          variant="body-medium-default"
          className="truncate text-[var(--content-secondary)]"
        >
          {sectionTitle}
        </Typography>,
      );
    } else {
      setTopBarCenter(null);
    }
    return () => {
      setTopBarCenter(null);
    };
  }, [isMobile, sectionTitle, setTopBarCenter]);

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
      <div className="mb-4 flex shrink-0 items-center gap-1.5">
        <Link
          to={routes.identity}
          className="-ml-2 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--content-secondary)] transition-colors outline-none hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          aria-label={t("intelligenceLayout.backToAriaLabel", {
            name: assistantName || t("identityOverview.defaultAssistantName"),
          })}
          title={t("intelligenceLayout.backToTitle", {
            name: assistantName || t("identityOverview.defaultAssistantName"),
          })}
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Link>
        <h1 className="text-title-large text-[var(--content-default)] max-md:hidden">
          {sectionTitle}
        </h1>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Outlet />
      </div>
    </PageShell>
  );
}
