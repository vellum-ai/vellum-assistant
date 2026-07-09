import { useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router";

import { Typography, cn } from "@vellumai/design-library";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { PageShell } from "@/components/page-shell";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useSupportsPluginsSurface } from "@/lib/backwards-compat/plugins-surface";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { routes } from "@/utils/routes";

interface IntelligenceTab {
  readonly label: string;
  readonly to: string;
}

const BASE_INTELLIGENCE_TABS: readonly IntelligenceTab[] = [
  { label: "Identity", to: routes.identity },
  { label: "Skills", to: routes.skills.root },
  { label: "Workspace", to: routes.workspace },
  { label: "Contacts", to: routes.contacts.root },
];

const PLUGINS_TAB: IntelligenceTab = {
  label: "Plugins",
  to: routes.plugins,
};

const CHANNELS_TAB: IntelligenceTab = {
  label: "Channels",
  to: routes.channels,
};

/**
 * Shared layout for the "About Assistant" pages (Identity, Skills,
 * Workspace, Contacts, plus Plugins on plugin-capable assistants and
 * Channels behind the `channel-trust-floors` flag). Renders a heading +
 * tab bar above an `<Outlet />` for the active tab's content.
 *
 * Mounted as a pathless layout route in `routes.tsx` so the child
 * routes keep their existing URL paths (`/assistant/identity`, etc.)
 * while inheriting the shared chrome.
 *
 * @see https://reactrouter.com/start/framework/routing#layout-routes
 */
export function IntelligenceLayout() {
  const assistantName = useAssistantIdentityStore.use.name();
  const supportsPlugins = useSupportsPluginsSurface();
  const showChannelsTab = useAssistantFeatureFlagStore.use.channelTrustFloors();
  const { pathname } = useLocation();
  const isMobile = useIsMobile();
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();

  // Insert the Plugins tab between Identity and Skills, but only when the
  // connected assistant is new enough to expose the plugin routes (see
  // `lib/backwards-compat/plugins-surface.ts`). On older assistants the
  // routes 404, so the tab stays hidden rather than linking to a broken
  // catalog. `useSupportsPluginsSurface` returns false until the version
  // hydrates, so the tab appears once identity resolves.
  //
  // The Channels tab is an unreleased surface gated on the
  // `channel-trust-floors` flag (it ships with that arc); while the flag is
  // off, channels are managed from the Contacts assistant detail instead.
  const withPlugins: readonly IntelligenceTab[] = supportsPlugins
    ? [BASE_INTELLIGENCE_TABS[0], PLUGINS_TAB, ...BASE_INTELLIGENCE_TABS.slice(1)]
    : BASE_INTELLIGENCE_TABS;
  const tabs: readonly IntelligenceTab[] = showChannelsTab
    ? [...withPlugins, CHANNELS_TAB]
    : withPlugins;

  // On mobile the title moves out of the page body and into the shared top
  // bar — centered between the hamburger menu and the search icon — so the
  // tab row can rise directly beneath the header. Desktop keeps the in-body
  // <h1> and leaves the top-bar center empty.
  useEffect(() => {
    if (isMobile) {
      setTopBarCenter(
        <Typography
          variant="body-medium-default"
          className="truncate text-[var(--content-secondary)]"
        >
          About {assistantName || "Assistant"}
        </Typography>,
      );
    } else {
      setTopBarCenter(null);
    }
    return () => {
      setTopBarCenter(null);
    };
  }, [isMobile, assistantName, setTopBarCenter]);

  return (
    <PageShell>
      <h1 className="mb-4 shrink-0 text-title-large text-[var(--content-default)] max-md:hidden">
        About {assistantName || "Assistant"}
      </h1>

      <nav
        className="mb-4 flex shrink-0 items-center overflow-x-auto border-b border-[var(--border-base)]"
        style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
        aria-label="About assistant sections"
      >
        {tabs.map(({ label, to }) => {
          const isActive =
            pathname === to || pathname.startsWith(to + "/");
          return (
            <NavLink
              key={to}
              to={to}
              className={cn(
                "relative -mb-px inline-flex cursor-pointer items-center gap-1.5 border-b-2 border-transparent bg-transparent px-2.5 py-[7px]",
                "text-body-medium-default whitespace-nowrap",
                "text-[var(--content-secondary)] transition-colors",
                "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-0",
                "hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
                isActive &&
                  "border-[var(--border-active)] text-[var(--primary-active)]",
                isActive && "hover:bg-transparent",
              )}
            >
              {label}
            </NavLink>
          );
        })}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Outlet />
      </div>
    </PageShell>
  );
}
