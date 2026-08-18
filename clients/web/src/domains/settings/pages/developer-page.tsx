import { useMemo } from "react";
import { Navigate, useSearchParams } from "react-router";
import { Tabs } from "@vellumai/design-library/components/tabs";

import { MemoryCard } from "@/domains/settings/components/memory-card";
import { AssistantLifecyclePanel } from "@/domains/settings/components/panels/assistant-lifecycle-panel";
import { EnvironmentConfigPanel } from "@/domains/settings/components/panels/environment-config-panel";
import { FeatureFlagsPanel } from "@/domains/settings/components/panels/feature-flags-panel";
import { SentryTestingPanel } from "@/domains/settings/components/panels/sentry-testing-panel";
import { useTranslation } from "@/i18n";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";

const ALL_TABS = [
  { id: "feature-flags", labelKey: "developerPage.tabFeatureFlags" },
  { id: "lifecycle", labelKey: "developerPage.tabLifecycle" },
  { id: "sentry", labelKey: "developerPage.tabSentry" },
  { id: "memory", labelKey: "developerPage.tabMemory" },
] as const;

type DeveloperTabId = (typeof ALL_TABS)[number]["id"];

/**
 * Every panel extends the page's flex column so the panels that scroll their
 * own content get a bounded height.
 */
const PANEL_CLASS = "flex min-h-0 flex-1 flex-col pt-6";

export function DeveloperPage() {
  const { t } = useTranslation("settings");
  const [searchParams, setSearchParams] = useSearchParams();
  const settingsDeveloperNav =
    useAssistantFeatureFlagStore.use.settingsDeveloperNav();
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();

  const activeTab: DeveloperTabId = useMemo(() => {
    const tabParam = searchParams.get("tab");
    const match = ALL_TABS.find((tab) => tab.id === tabParam);
    return match?.id ?? "feature-flags";
  }, [searchParams]);

  if (hasHydrated && !settingsDeveloperNav) {
    return <Navigate replace to={routes.settings.general} />;
  }

  // Writes whatever `Tabs.Root` reports straight to `?tab=`; the read above is
  // the single place a param is narrowed back to a known tab.
  const setActiveTab = (tabId: string) => {
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
      <Tabs.Root
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.List
          className="shrink-0"
          aria-label={t("developerPage.sectionsAriaLabel")}
        >
          {ALL_TABS.map((tab) => (
            <Tabs.Trigger key={tab.id} value={tab.id}>
              {t(tab.labelKey)}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Panel value="feature-flags" className={PANEL_CLASS}>
          <div className="space-y-6">
            <FeatureFlagsPanel />
            <EnvironmentConfigPanel />
          </div>
        </Tabs.Panel>
        <Tabs.Panel value="lifecycle" className={PANEL_CLASS}>
          <AssistantLifecyclePanel />
        </Tabs.Panel>
        <Tabs.Panel value="sentry" className={PANEL_CLASS}>
          <SentryTestingPanel />
        </Tabs.Panel>
        <Tabs.Panel value="memory" className={PANEL_CLASS}>
          <div className="space-y-4">
            <MemoryCard />
          </div>
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}
