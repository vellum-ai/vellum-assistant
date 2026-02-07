"use client";

import { ArchitectureTab } from "./_ArchitectureTab";
import { DetailsTab } from "./_DetailsTab";
import { FileSystemTab } from "./_FileSystemTab";
import { InteractionTab } from "./_InteractionTab";
import { LogsTab } from "./_LogsTab";

export type TabId = "interaction" | "architecture" | "filesystem" | "logs" | "details";

export interface Tab {
  id: TabId;
  label: string;
}

export const TABS: Tab[] = [
  { id: "interaction", label: "Interaction" },
  { id: "architecture", label: "Architecture" },
  { id: "filesystem", label: "File System" },
  { id: "logs", label: "Logs" },
  { id: "details", label: "Details" },
];

interface RightPanelProps {
  agentId: string;
  agentName: string;
  agentCreatedAt: string;
  activeTab: TabId;
}

export function RightPanel({ agentId, agentName, agentCreatedAt, activeTab }: RightPanelProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-hidden">
        {activeTab === "interaction" && (
          <InteractionTab agentId={agentId} agentName={agentName} agentCreatedAt={agentCreatedAt} />
        )}
        {activeTab === "architecture" && (
          <ArchitectureTab agentName={agentName} />
        )}
        {activeTab === "filesystem" && <FileSystemTab agentId={agentId} />}
        {activeTab === "logs" && <LogsTab agentId={agentId} />}
        {activeTab === "details" && <DetailsTab agentId={agentId} />}
      </div>
    </div>
  );
}
