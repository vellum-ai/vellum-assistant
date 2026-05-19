import type { Route } from "@/types/route.js";

import { useNavigate, useSearchParams } from "react-router";
import { Suspense, useEffect } from "react";

import { routes } from "@/lib/routes.js";

const TAB_TO_ROUTE: Record<string, Route> = {
  // Preserve old explicit deep links to the log stream; only the bare
  // /assistant/logs desktop entry point now defaults to Usage.
  logs: routes.logs.trace,
  usage: routes.logs.usage,
  "system-events": routes.logs.systemEvents,
};

/**
 * Logs & Usage index. On mobile this resolves to the menu (rendered by
 * `SettingsShell` based on the pathname); on desktop, where the menu
 * lives in the persistent sidebar, we forward to the Usage sub-page so
 * the content area is never empty. Also translates legacy `?tab=`
 * query-string deep-links from before this page was split into routes.
 */
function LogsPageInner() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const tab = searchParams.get("tab");
    const tabRoute = tab ? TAB_TO_ROUTE[tab] : undefined;
    if (tabRoute) {
      navigate(tabRoute, { replace: true });
      return;
    }
    if (window.matchMedia("(min-width: 768px)").matches) {
      navigate(routes.logs.usage, { replace: true });
    }
  }, [navigate, searchParams]);

  return null;
}

export default function LogsPage() {
  return (
    <Suspense>
      <LogsPageInner />
    </Suspense>
  );
}
