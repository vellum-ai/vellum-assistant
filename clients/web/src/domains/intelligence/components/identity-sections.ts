/**
 * The drill-down sections reachable from the assistant overview page —
 * the replacement for the old About Assistant tab bar. Labels and paths
 * come from the shared `ABOUT_ASSISTANT_SECTIONS` registry in
 * `utils/routes.ts`; this module owns only what is overview-specific:
 * ordering and descriptions. Pure so the section list is unit-testable
 * without rendering the overview.
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

/** Registry section + the overview's own description line. */
function section(
  key: AboutAssistantSectionKey,
  description: string,
): IdentitySection {
  const { label, to } = aboutAssistantSection(key);
  return { key, label, description, to };
}

export function buildIdentitySections(): IdentitySection[] {
  return [
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
    // Unconditional. Memory is part of what every assistant is, so the card is
    // always the way in — an assistant whose backend can't draw the concept
    // graph (memory off, or a pre-v3 engine) gets a Memory tab that explains
    // that and offers the fix, rather than a card that silently disappears.
    section("memory", "What I remember"),
    // Library's list page wears the shared section chrome like its peers;
    // the app viewer (/assistant/library/:appId) renders full-bleed.
    section("library", "My apps & docs"),
    section("workspace", "My files"),
    section("contacts", "People I know"),
    section("channels", "Where I listen"),
  ];
}
