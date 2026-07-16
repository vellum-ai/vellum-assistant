import { useEffect } from "react";
import { ChevronLeft } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router";

import { Typography } from "@vellumai/design-library";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { PageShell } from "@/components/page-shell";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { routes } from "@/utils/routes";

interface IntelligenceSection {
  readonly label: string;
  readonly to: string;
}

/**
 * The drill-down section pages that get the shared back-button chrome.
 * Sub-paths (e.g. `/assistant/plugins/:name`) count as inside a section.
 */
const CHROME_SECTIONS: readonly IntelligenceSection[] = [
  { label: "Schedules", to: routes.schedules.root },
  { label: "Plugins", to: routes.plugins },
  { label: "Skills", to: routes.skills.root },
  { label: "Memory", to: routes.memory },
  { label: "Workspace", to: routes.workspace },
  { label: "Contacts", to: routes.contacts.root },
  { label: "Channels", to: routes.channels },
];

function sectionForPath(pathname: string): IntelligenceSection | null {
  return (
    CHROME_SECTIONS.find(
      ({ to }) => pathname === to || pathname.startsWith(to + "/"),
    ) ?? null
  );
}

/**
 * Shared layout for the "About Assistant" pages. The overview
 * (`/assistant/identity`) and the personality page render full-bleed —
 * they own their avatar-tinted stage chrome — while every other section
 * (Schedules, Plugins, Skills, Memory, Workspace, Contacts, Channels)
 * renders inside the standard page shell with a back button to the
 * overview where the old tab bar used to be.
 *
 * Mounted as a pathless layout route in `routes.tsx` so the child routes
 * keep their existing URL paths (`/assistant/identity`, etc.) while
 * inheriting the shared chrome.
 *
 * @see https://reactrouter.com/start/framework/routing#layout-routes
 */
export function IntelligenceLayout() {
  const assistantName = useAssistantIdentityStore.use.name();
  const { pathname } = useLocation();
  const isMobile = useIsMobile();
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();

  const section = sectionForPath(pathname);
  const mobileTitle = section?.label ?? null;

  // On mobile the section title moves out of the page body and into the
  // shared top bar — centered between the hamburger menu and the search
  // icon. The bare pages (overview, personality) set no title: the
  // greeting on the stage already names the assistant. Desktop keeps the
  // in-body <h1> (section pages only) and leaves the top-bar center empty.
  useEffect(() => {
    if (isMobile && mobileTitle) {
      setTopBarCenter(
        <Typography
          variant="body-medium-default"
          className="truncate text-[var(--content-secondary)]"
        >
          {mobileTitle}
        </Typography>,
      );
    } else {
      setTopBarCenter(null);
    }
    return () => {
      setTopBarCenter(null);
    };
  }, [isMobile, mobileTitle, setTopBarCenter]);

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
          aria-label={`Back to ${assistantName || "Assistant"}`}
          title={`Back to ${assistantName || "Assistant"}`}
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Link>
        <h1 className="text-title-large text-[var(--content-default)] max-md:hidden">
          {section.label}
        </h1>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Outlet />
      </div>
    </PageShell>
  );
}
