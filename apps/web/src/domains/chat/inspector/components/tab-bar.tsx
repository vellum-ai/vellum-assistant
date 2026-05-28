import { type ReactNode } from "react";

import { cn } from "@/utils/misc";

export type InspectorTab =
  | "overview"
  | "prompt"
  | "response"
  | "raw"
  | "compaction"
  | "skills"
  | "memory";

const TABS: { id: InspectorTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "prompt", label: "Prompt" },
  { id: "response", label: "Response" },
  { id: "raw", label: "Raw" },
  { id: "compaction", label: "Compaction" },
  { id: "skills", label: "Skills" },
  { id: "memory", label: "Memory" },
];

interface TabBarProps {
  selected: InspectorTab;
  onSelect: (tab: InspectorTab) => void;
}

export function TabBar({ selected, onSelect }: TabBarProps): ReactNode {
  return (
    // Seven tabs overflow most phone viewports, so the row scrolls
    // horizontally instead of getting clipped at the right edge. Each
    // button keeps its label on one line via `whitespace-nowrap`.
    <div
      className="flex shrink-0 overflow-x-auto px-4"
      style={{ borderBottom: "1px solid var(--border-base)" }}
      role="tablist"
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={selected === tab.id}
          onClick={() => onSelect(tab.id)}
          className={cn(
            "-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-label-medium-default transition-colors",
            selected === tab.id
              ? "border-[var(--primary-base)] text-[var(--content-default)]"
              : "border-transparent text-[var(--content-secondary)] hover:text-[var(--content-default)]",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
