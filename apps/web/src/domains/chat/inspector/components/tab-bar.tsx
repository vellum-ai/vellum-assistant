import { type ReactNode } from "react";

import { cn } from "@/utils/misc.js";

export type InspectorTab =
  | "overview"
  | "prompt"
  | "response"
  | "raw"
  | "skills"
  | "memory";

const TABS: { id: InspectorTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "prompt", label: "Prompt" },
  { id: "response", label: "Response" },
  { id: "raw", label: "Raw" },
  { id: "skills", label: "Skills" },
  { id: "memory", label: "Memory" },
];

interface TabBarProps {
  selected: InspectorTab;
  onSelect: (tab: InspectorTab) => void;
}

export function TabBar({ selected, onSelect }: TabBarProps): ReactNode {
  return (
    <div
      className="flex shrink-0 px-4"
      style={{ borderBottom: "1px solid var(--border-base)" }}
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onSelect(tab.id)}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-label-medium-default transition-colors",
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
