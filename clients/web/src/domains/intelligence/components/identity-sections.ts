/**
 * The drill-down sections reachable from the assistant overview page —
 * the replacement for the old About Assistant tab bar. Labels and paths
 * come from the shared `ABOUT_ASSISTANT_SECTIONS` registry in
 * `utils/routes.ts`; this module owns only what is overview-specific:
 * ordering, descriptions, and capability gating. Pure so the gating
 * (memory-graph availability) is unit-testable without rendering the
 * overview.
 */

import {
  aboutAssistantSection,
  type AboutAssistantSectionKey,
  routes,
} from "@/utils/routes";

export interface IdentitySection {
  key: string;
  label: string;
  /** One playful line under the label — written in the assistant's voice. */
  description: string;
  to: string;
}

export interface IdentitySectionGates {
  /**
   * Whether the memory-concept graph is available for this assistant (memory
   * v3 live, reported by `GET /memory/stats` as `graph_supported`). The Memory
   * surface is native — no feature flag — but only offered where the graph can
   * actually build, so it never dead-ends on a "not available" graph.
   */
  showMemory: boolean;
}

/** Registry section + the overview's own description line. */
function section(
  key: AboutAssistantSectionKey,
  description: string,
): IdentitySection {
  const { label, to } = aboutAssistantSection(key);
  return { key, label, description, to };
}

export function buildIdentitySections({
  showMemory,
}: IdentitySectionGates): IdentitySection[] {
  const sections: IdentitySection[] = [
    // Personality renders bare (full-bleed stage chrome), so it is not a
    // registry section — the overview links it directly.
    {
      key: "personality",
      label: "Personality",
      description: "Tune how I talk",
      to: routes.personality,
    },
    section("schedules", "My routines"),
    // Skills and plugins combined into one list; on assistants without the
    // plugin surface the page itself degrades to skills-only.
    section("superpowers", "What I can do"),
  ];
  if (showMemory) {
    sections.push(section("memory", "What I remember"));
  }
  sections.push(
    // Library's list page wears the shared section chrome like its peers;
    // the app viewer (/assistant/library/:appId) renders full-bleed.
    section("library", "My apps & docs"),
    section("workspace", "My files"),
    section("contacts", "People I know"),
    section("channels", "Where I listen"),
  );
  return sections;
}
