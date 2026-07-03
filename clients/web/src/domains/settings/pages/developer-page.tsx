import { useMemo } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";

import { AssistantLifecyclePanel } from "@/domains/settings/components/panels/assistant-lifecycle-panel";
import { EnvironmentConfigPanel } from "@/domains/settings/components/panels/environment-config-panel";
import { FeatureFlagsPanel } from "@/domains/settings/components/panels/feature-flags-panel";
import { SentryTestingPanel } from "@/domains/settings/components/panels/sentry-testing-panel";
import { isLocalMode } from "@/lib/local-mode";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { cn } from "@/utils/misc";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

const ALL_TABS = [
  { id: "feature-flags", label: "Feature Flags" },
  { id: "lifecycle", label: "Assistant Lifecycle" },
  { id: "sentry", label: "Sentry Testing" },
] as const;

type DeveloperTabId = (typeof ALL_TABS)[number]["id"];

export function DeveloperPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const settingsDeveloperNav = useAssistantFeatureFlagStore.use.settingsDeveloperNav();
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();

  const activeTab: DeveloperTabId = useMemo(() => {
    const tabParam = searchParams.get("tab");
    const match = ALL_TABS.find((tab) => tab.id === tabParam);
    return match?.id ?? "feature-flags";
  }, [searchParams]);

  if (hasHydrated && !settingsDeveloperNav) {
    return <Navigate replace to={routes.settings.general} />;
  }

  const setActiveTab = (tabId: DeveloperTabId) => {
    const params = new URLSearchParams(searchParams.toString());
    if (tabId === "feature-flags") {
      params.delete("tab");
    } else {
      params.set("tab", tabId);
    }
    setSearchParams(params, { replace: true });
  };

  return (
    <div data-slot="developer-page" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--border-base)]">
        <div
          role="tablist"
          aria-label="Developer sections"
          className="flex items-center gap-1"
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
                  "relative -mb-px cursor-pointer border-b-2 px-4 py-2 text-body-medium-default transition-colors",
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
        {isLocalMode() && (
          <Button
            variant="outlined"
            className="mb-1 shrink-0"
            onClick={() => void navigate(`${routes.selectAssistant}?noAutoSkip=1`)}
          >
            Choose Assistant
          </Button>
        )}
      </div>

      <div
        id={`developer-tab-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`developer-tab-${activeTab}`}
        className="flex min-h-0 flex-1 flex-col pt-6"
      >
        {activeTab === "feature-flags" && (
          <div className="space-y-6">
            <FeatureFlagsPanel />
            <EnvironmentConfigPanel />
          </div>
        )}
        {activeTab === "lifecycle" && <AssistantLifecyclePanel />}
        {activeTab === "sentry" && <SentryTestingPanel />}
      </div>
    </div>
  );
}
