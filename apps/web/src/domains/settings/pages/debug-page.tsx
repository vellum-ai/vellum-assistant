import { useMemo } from "react";
import { useSearchParams } from "react-router";

import { AssistantTerminalPanel } from "@/domains/settings/components/panels/assistant-terminal-panel";
import { DebugControlsPanel } from "@/domains/settings/components/panels/debug-controls-panel";
import { DoctorPanel } from "@/domains/settings/components/panels/doctor-panel";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { cn } from "@/utils/misc";

const ALL_TABS = [
  { id: "general", label: "General" },
  { id: "terminal", label: "Terminal" },
  { id: "doctor", label: "Doctor" },
] as const;

type DebugTabId = (typeof ALL_TABS)[number]["id"];

export function DebugPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Terminal tab is platform-routed and should be hidden when the active
  // assistant is self-hosted — `platformHostedOnly: true` is the correct
  // variant. The standard gate would still resolve to "full" on a
  // platform-mode app pointed at a self-hosted assistant, leaving the
  // tab visible and letting the user land on a doomed terminal connection.
  const platformGate = usePlatformGate({ platformHostedOnly: true });

  const tabs = useMemo(
    () =>
      ALL_TABS.filter((tab) => {
        // Terminal is platform-routed — hide the tab entirely on self-hosted
        // assistants so users don't land on an empty panel.
        if (tab.id === "terminal" && platformGate === "gated") return false;
        return true;
      }),
    [platformGate],
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
    setSearchParams(params, { replace: true });
  };

  return (
    <div data-slot="debug-page" className="flex min-h-0 flex-1 flex-col">
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

      <div
        id={`debug-tab-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`debug-tab-${activeTab}`}
        className="flex min-h-0 flex-1 flex-col pt-6"
      >
        {activeTab === "general" && <DebugControlsPanel />}
        {activeTab === "terminal" && <AssistantTerminalPanel />}
        {activeTab === "doctor" && <DoctorPanel />}
      </div>
    </div>
  );
}
