
import { Suspense, useMemo } from "react";

import { useAppRouting } from "@/adapters/app-routing.js";

import { AssistantTerminalPanel } from "@/components/app/settings/panels/AssistantTerminalPanel.js";
import { DebugControlsPanel } from "@/components/app/settings/panels/DebugControlsPanel.js";
import { DoctorPanel } from "@/components/app/settings/panels/doctor-panel.js";
import { useAppFeatureFlags } from "@/lib/feature-flags/feature-flag-provider.js";
import { routes } from "@/lib/routes.js";
import { cn } from "@vellum/design-library/utils/cn";

const ALL_TABS = [
  { id: "general", label: "General" },
  { id: "terminal", label: "Terminal" },
  { id: "doctor", label: "Doctor" },
] as const;

type DebugTabId = (typeof ALL_TABS)[number]["id"];

function DebugSettingsPageInner() {
  const { replace, searchParams } = useAppRouting();
  const { doctor: doctorEnabled } = useAppFeatureFlags();

  const tabs = useMemo(
    () => ALL_TABS.filter((tab) => tab.id !== "doctor" || doctorEnabled),
    [doctorEnabled],
  );

  const activeTab: DebugTabId = useMemo(() => {
    const tabParam = searchParams.get("tab");
    const match = tabs.find((tab) => tab.id === tabParam);
    return match?.id ?? "general";
  }, [searchParams, tabs]);

  const setActiveTab = (tabId: DebugTabId) => {
    const params = new URLSearchParams(searchParams.toString());
    if (tabId === "general") {
      params.delete("tab");
    } else {
      params.set("tab", tabId);
    }
    const query = params.toString();
    replace(
      query ? `${routes.settings.debug}?${query}` : routes.settings.debug,
    );
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div
        role="tablist"
        aria-label="Debug sections"
        className="flex shrink-0 items-center gap-1 border-b border-[var(--border-base)]"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`debug-tab-panel-${tab.id}`}
              id={`debug-tab-${tab.id}`}
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
        id={`debug-tab-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`debug-tab-${activeTab}`}
        className="flex flex-1 flex-col min-h-0 pt-6"
      >
        {activeTab === "general" && (
          <div className="max-w-[940px]">
            <DebugControlsPanel />
          </div>
        )}
        {activeTab === "terminal" && <AssistantTerminalPanel />}
        {activeTab === "doctor" && doctorEnabled && <DoctorPanel />}
      </div>
    </div>
  );
}

export default function DebugSettingsPage() {
  return (
    <Suspense>
      <DebugSettingsPageInner />
    </Suspense>
  );
}
