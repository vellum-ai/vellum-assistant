"use client";

import { DetailsTab } from "./_DetailsTab";
import { FileSystemTab } from "./_FileSystemTab";
import { InteractionTab } from "./_InteractionTab";

export type TabId = "interaction" | "filesystem" | "details";

export interface Tab {
  id: TabId;
  label: string;
}

export const TABS: Tab[] = [
  { id: "interaction", label: "Chat" },
  { id: "filesystem", label: "File System" },
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
        {activeTab === "filesystem" && <FileSystemTab assistantId={assistantId} />}
        {activeTab === "details" && <DetailsTab assistantId={assistantId} />}
      </div>
    </div>
  );
}
