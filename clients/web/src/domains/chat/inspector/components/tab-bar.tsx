import { type ReactNode } from "react";

import { Tabs } from "@vellumai/design-library/components/tabs";

export type InspectorTab =
  | "overview"
  | "prompt"
  | "response"
  | "raw"
  | "compaction"
  | "skills"
  | "memory";

export const TABS: { id: InspectorTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "prompt", label: "Prompt" },
  { id: "response", label: "Response" },
  { id: "raw", label: "Raw" },
  { id: "compaction", label: "Compaction" },
  { id: "skills", label: "Skills" },
  { id: "memory", label: "Memory" },
];

/**
 * `Tabs.Root` reports the selected value as a plain string, so hosts narrow it
 * back to the union before storing it.
 */
export function isInspectorTab(value: string): value is InspectorTab {
  return TABS.some((tab) => tab.id === value);
}

/**
 * The inspector's tab row. Renders the triggers only: the selected value and
 * the panels belong to the `Tabs.Root` the host mounts around this and its
 * content, which is what wires each trigger to the panel it controls.
 */
export function TabBar(): ReactNode {
  return (
    // Seven tabs overflow most phone viewports, so the row scrolls
    // horizontally instead of getting clipped at the right edge. Each
    // trigger keeps its full width via `shrink-0`.
    <Tabs.List className="shrink-0 overflow-x-auto px-4">
      {TABS.map((tab) => (
        <Tabs.Trigger key={tab.id} value={tab.id} className="shrink-0">
          {tab.label}
        </Tabs.Trigger>
      ))}
    </Tabs.List>
  );
}
