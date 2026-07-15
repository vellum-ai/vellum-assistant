import { useMemo } from "react";

import { useSearchParams } from "react-router";

import { AssistantTerminalPanel } from "@/domains/settings/components/panels/assistant-terminal-panel";
import { DebugControlsPanel } from "@/domains/settings/components/panels/debug-controls-panel";
import { DoctorPanel } from "@/domains/settings/components/panels/doctor-panel";
import { ArchiveSections } from "@/domains/settings/pages/archive-sections";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { Tabs } from "@vellumai/design-library/components/tabs";

const ALL_TABS = [
  { id: "general", label: "General" },
  { id: "terminal", label: "Terminal" },
  { id: "doctor", label: "Doctor" },
  { id: "archive", label: "Archive" },
] as const;

type DebugTabId = (typeof ALL_TABS)[number]["id"];

const DEFAULT_TAB: DebugTabId = "general";

export function DebugPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Terminal and Doctor are platform-routed and must be hidden when the active
  // assistant is self-hosted — `platformHostedOnly: true` is the correct
  // variant. The standard gate still resolves to "full" on a platform-mode app
  // pointed at a self-hosted assistant, leaving the tabs visible and letting the
  // user land on a doomed terminal/doctor connection.
  const platformGate = usePlatformGate({ platformHostedOnly: true });

  const tabs = useMemo(
    () =>
      ALL_TABS.filter((tab) => {
        if (tab.id === "terminal" && platformGate === "gated") {
          return false;
        }
        if (tab.id === "doctor" && platformGate === "gated") {
          return false;
        }
        return true;
      }),
    [platformGate],
  );

  // A gated deep-link (e.g. ?tab=doctor on a self-hosted assistant) has no
  // matching visible tab, so fall back to General rather than rendering a
  // panel with no trigger.
  const activeTab: DebugTabId = useMemo(() => {
    const tabParam = searchParams.get("tab");
    const match = tabs.find((tab) => tab.id === tabParam);
    return match?.id ?? DEFAULT_TAB;
  }, [searchParams, tabs]);

  const handleTabChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === DEFAULT_TAB) {
      next.delete("tab");
    } else {
      next.set("tab", value);
    }
    setSearchParams(next, { replace: true });
  };

  return (
    // The Terminal and Doctor panels rely on a `flex min-h-0 flex-1 flex-col`
    // ancestor chain to size their console/messages area; the settings `<main>`
    // is a bounded-height flex column, so the page root and Tabs.Root extend
    // that chain. General and Archive keep block flow (`pt-4`) and scroll.
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs.Root
        value={activeTab}
        onValueChange={handleTabChange}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.List>
          {tabs.map((tab) => (
            <Tabs.Trigger key={tab.id} value={tab.id}>
              {tab.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Panel value="general" className="pt-4">
          <DebugControlsPanel />
        </Tabs.Panel>
        {tabs.some((tab) => tab.id === "terminal") && (
          <Tabs.Panel
            value="terminal"
            className="flex min-h-0 flex-1 flex-col pt-4"
          >
            <AssistantTerminalPanel />
          </Tabs.Panel>
        )}
        {tabs.some((tab) => tab.id === "doctor") && (
          <Tabs.Panel
            value="doctor"
            className="flex min-h-0 flex-1 flex-col pt-4"
          >
            <DoctorPanel />
          </Tabs.Panel>
        )}
        <Tabs.Panel value="archive" className="pt-4">
          <ArchiveSections />
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}
