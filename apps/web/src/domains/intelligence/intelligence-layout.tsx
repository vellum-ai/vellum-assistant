import { NavLink, Outlet, useLocation, useOutletContext } from "react-router";

import { cn } from "@vellum/design-library";

import { PageShell } from "@/components/page-shell.js";
import { routes } from "@/utils/routes.js";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store.js";

const INTELLIGENCE_TABS = [
  { label: "Identity", to: routes.identity },
  { label: "Skills", to: routes.skills },
  { label: "Workspace", to: routes.workspace },
  { label: "Contacts", to: routes.contacts.root },
] as const;

/**
 * Shared layout for the "About Assistant" pages (Identity, Skills,
 * Workspace, Contacts). Renders a heading + tab bar above an
 * `<Outlet />` for the active tab's content.
 *
 * Mounted as a pathless layout route in `routes.tsx` so the child
 * routes keep their existing URL paths (`/assistant/identity`, etc.)
 * while inheriting the shared chrome.
 *
 * References:
 * - React Router layout routes: https://reactrouter.com/start/framework/routing#layout-routes
 * - Platform source: AssistantPageClient.tsx lines 2250-2290
 */
export function IntelligenceLayout() {
  const assistantName = useAssistantIdentityStore.use.name();
  const { pathname } = useLocation();
  const outletContext = useOutletContext();

  return (
    <PageShell>
      <h1 className="mb-4 shrink-0 text-title-large text-[var(--content-default)]">
        About {assistantName || "Assistant"}
      </h1>

      <nav
        className="mb-4 flex shrink-0 items-center overflow-x-auto border-b border-[var(--border-base)]"
        style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
        aria-label="About assistant sections"
      >
        {INTELLIGENCE_TABS.map(({ label, to }) => {
          const isActive =
            pathname === to || pathname.startsWith(to + "/");
          return (
            <NavLink
              key={to}
              to={to}
              className={cn(
                "relative -mb-px inline-flex cursor-pointer items-center gap-1.5 border-b-2 border-transparent bg-transparent px-2.5 py-[7px]",
                "text-body-medium-default whitespace-nowrap",
                "text-[var(--content-tertiary)] transition-colors",
                "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-0",
                "hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
                isActive &&
                  "border-[var(--primary-base)] text-[var(--content-default)]",
                isActive && "hover:bg-transparent",
              )}
            >
              {label}
            </NavLink>
          );
        })}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Outlet context={outletContext} />
      </div>
    </PageShell>
  );
}
