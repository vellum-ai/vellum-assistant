/**
 * Catalog of task categories surfaced on the PreChat task-tone selection
 * screen. Mirrors the macOS `TaskToneSelectionView.swift` catalog so the two
 * surfaces stay in lock-step.
 *
 * `iconKey` is intentionally a stringly-typed identifier rather than a
 * lucide-react component reference: this module is pure data and must not
 * depend on the icon library. The screen component owns the mapping from
 * `iconKey` to the actual icon component.
 */

export interface PreChatTaskCategory {
  /** Stable id used for selection state and analytics. */
  id: string;
  /**
   * Stringly-typed icon identifier. The PreChat screen maps this to a
   * lucide-react icon component. Decouples this catalog from the icon library.
   */
  iconKey: string;
  /** Short headline shown in the tile. */
  label: string;
  /** Supporting copy shown beneath the headline. */
  sublabel: string;
}

/**
 * Ordered catalog of task categories. Order matches macOS
 * `TaskToneSelectionView.swift` (lines 31-38) — do not reorder without
 * updating the macOS source as well.
 */
export const PRECHAT_TASKS: readonly PreChatTaskCategory[] = [
  {
    id: "code-building",
    iconKey: "wrench",
    label: "Building",
    sublabel: "code, apps, tools",
  },
  {
    id: "writing",
    iconKey: "pencil",
    label: "Writing",
    sublabel: "docs, emails, content",
  },
  {
    id: "research",
    iconKey: "search",
    label: "Researching",
    sublabel: "digging into stuff, analysis",
  },
  {
    id: "project-management",
    iconKey: "clipboardList",
    label: "Planning & coordinating",
    sublabel: "roadmaps, specs, tracking work",
  },
  {
    id: "scheduling",
    iconKey: "calendar",
    label: "Scheduling",
    sublabel: "meetings, calendar, logistics",
  },
  {
    id: "personal",
    iconKey: "user",
    label: "Life admin",
    sublabel: "bills, travel, household, errands",
  },
];
