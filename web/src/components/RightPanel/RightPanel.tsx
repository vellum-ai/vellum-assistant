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
  assistantId: string;
  assistantName: string;
  assistantCreatedAt: string;
  activeTab: TabId;
}

export function RightPanel({ assistantId, assistantName, assistantCreatedAt, activeTab }: RightPanelProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-hidden">
        {activeTab === "interaction" && (
          <InteractionTab assistantId={assistantId} assistantName={assistantName} assistantCreatedAt={assistantCreatedAt} />
        )}
        {activeTab === "architecture" && (
          <ArchitectureTab assistantName={assistantName} />
        )}
        {activeTab === "filesystem" && <FileSystemTab assistantId={assistantId} />}
        {activeTab === "logs" && <LogsTab assistantId={assistantId} />}
        {activeTab === "details" && <DetailsTab assistantId={assistantId} />}
      </div>
    </div>
  );
}
