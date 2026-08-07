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

/**
 * Sections the native mobile shells leave off the overview. The test is
 * whether the task belongs on a phone, not how finished the surface looks:
 * curating memories and browsing host files are desk work, so on iOS and
 * Android those two are noise.
 *
 * Contacts and Channels are deliberately absent from this list. Who the
 * assistant knows and where it listens are exactly what someone needs to
 * check and change while away from their desk, so they earn a card even
 * though their mobile UI is still rough. An unpolished way in beats no way
 * in. Do not re-add them for looking unfinished; that is a reason to polish
 * them, not to hide them.
 *
 * Only the overview cards go: the routes stay registered and reachable by
 * deep link, so moving a section either way is a single edit to this list.
 */
const NATIVE_MOBILE_HIDDEN_KEYS: readonly string[] = ["memory", "workspace"];

export interface BuildIdentitySectionsOptions {
  /** True inside the iOS or Android Capacitor shell. */
  isNativeMobile?: boolean;
}

export function buildIdentitySections({
  isNativeMobile = false,
}: BuildIdentitySectionsOptions = {}): IdentitySection[] {
  const sections: IdentitySection[] = [
    // Personality renders bare (full-bleed stage chrome), so it is not a
    // registry section. The overview links it directly.
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
    // Never gated on backend capability. Memory is part of what every
    // assistant is, so wherever the card shows it is always the way in: an
    // assistant whose backend can't draw the concept graph (memory off, or a
    // pre-v3 engine) gets a Memory tab that explains that and offers the fix,
    // rather than a card that silently disappears. The native mobile filter
    // below is the only thing that removes it.
    section("memory", "What I remember"),
    // Library's list page wears the shared section chrome like its peers;
    // the app viewer (/assistant/library/:appId) renders full-bleed.
    section("library", "My apps & docs"),
    section("workspace", "My files"),
    section("contacts", "People I know"),
    section("channels", "Where I listen"),
  ];
  if (!isNativeMobile) {
    return sections;
  }
  return sections.filter(
    (entry) => !NATIVE_MOBILE_HIDDEN_KEYS.includes(entry.key),
  );
}
