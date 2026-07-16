import { useCallback, useMemo } from "react";

import { useNavigate, useSearchParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { AllConversationsView } from "@/domains/settings/components/all-conversations-view";
import { AssistantTerminalPanel } from "@/domains/settings/components/panels/assistant-terminal-panel";
import { DebugControlsPanel } from "@/domains/settings/components/panels/debug-controls-panel";
import { DoctorPanel } from "@/domains/settings/components/panels/doctor-panel";
import { resolveDebugTabParam } from "@/domains/settings/pages/debug-page.helpers";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { routes } from "@/utils/routes";
import { Tabs } from "@vellumai/design-library/components/tabs";

const ALL_TABS = [
  { id: "general", label: "General" },
  { id: "terminal", label: "Terminal" },
  { id: "doctor", label: "Doctor" },
  { id: "conversations", label: "Conversations" },
] as const;

type DebugTabId = (typeof ALL_TABS)[number]["id"];

const DEFAULT_TAB: DebugTabId = "general";

export function DebugPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();

  const handleOpenConversation = useCallback(
    (conversationId: string) => {
      void navigate(routes.conversation(conversationId));
    },
    [navigate],
  );
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
  const { tabId, conversationsFilter } = resolveDebugTabParam(
    searchParams.get("tab"),
  );

  const activeTab: DebugTabId = useMemo(() => {
    const match = tabs.find((tab) => tab.id === tabId);
    return match?.id ?? DEFAULT_TAB;
  }, [tabId, tabs]);

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
    // that chain. General keeps block flow (`pt-4`) and scrolls.
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
        <Tabs.Panel
          value="conversations"
          className="flex min-h-0 flex-1 flex-col pt-4"
        >
          {/* `initialFilter` only seeds state on mount, and the panel stays
              mounted when ?tab flips archive→conversations, so key on the
              intended filter to re-seed it. */}
          <AllConversationsView
            key={conversationsFilter}
            assistantId={assistantId}
            initialFilter={conversationsFilter}
            onOpenConversation={handleOpenConversation}
          />
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}
