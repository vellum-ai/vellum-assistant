
import { Suspense, useMemo } from "react";

import { useAppRouting } from "@/adapters/app-routing.js";

import { AssistantLifecyclePanel } from "@/components/app/settings/panels/developer/assistant-lifecycle-panel.js";
import { FeatureFlagsPanel } from "@/components/app/settings/panels/developer/feature-flags-panel.js";
import { SentryTestingPanel } from "@/components/app/settings/panels/developer/sentry-testing-panel.js";
import { routes } from "@/lib/routes.js";
import { cn } from "@vellum/design-library/utils/cn";

const ALL_TABS = [
  { id: "feature-flags", label: "Feature Flags" },
  { id: "lifecycle", label: "Assistant Lifecycle" },
  { id: "sentry", label: "Sentry Testing" },
] as const;

type DeveloperTabId = (typeof ALL_TABS)[number]["id"];

function DeveloperSettingsInner() {
  const { replace, searchParams } = useAppRouting();

  const activeTab: DeveloperTabId = useMemo(() => {
    const tabParam = searchParams.get("tab");
    const match = ALL_TABS.find((tab) => tab.id === tabParam);
    return match?.id ?? "feature-flags";
  }, [searchParams]);

  const setActiveTab = (tabId: DeveloperTabId) => {
    const params = new URLSearchParams(searchParams.toString());
    if (tabId === "feature-flags") {
      params.delete("tab");
    } else {
      params.set("tab", tabId);
    }
    const query = params.toString();
    replace(
      query
        ? `${routes.settings.developer}?${query}`
        : routes.settings.developer,
    );
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div
        role="tablist"
        aria-label="Developer sections"
        className="flex shrink-0 items-center gap-1 border-b border-[var(--border-base)]"
      >
        {ALL_TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`developer-tab-panel-${tab.id}`}
              id={`developer-tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "relative cursor-pointer border-b-2 px-4 py-2 text-body-medium-default transition-colors -mb-px",
                isActive
                  ? "border-[var(--system-positive-strong)] text-[var(--system-positive-strong)]"
                  : "border-transparent text-[var(--content-tertiary)] hover:text-[var(--content-default)] dark:text-[var(--content-disabled)] dark:hover:text-[var(--content-default)]",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        id={`developer-tab-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`developer-tab-${activeTab}`}
        className="flex flex-1 flex-col min-h-0 pt-6"
      >
        {activeTab === "feature-flags" && (
          <div className="max-w-[940px]">
            <FeatureFlagsPanel />
          </div>
        )}
        {activeTab === "lifecycle" && (
          <div className="max-w-[940px]">
            <AssistantLifecyclePanel />
          </div>
        )}
        {activeTab === "sentry" && (
          <div className="max-w-[940px]">
            <SentryTestingPanel />
          </div>
        )}
      </div>
    </div>
  );
}

export function DeveloperSettingsContent() {
  return (
    <Suspense>
      <DeveloperSettingsInner />
    </Suspense>
  );
}
