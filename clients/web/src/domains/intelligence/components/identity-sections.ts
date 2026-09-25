/**
 * The drill-down sections reachable from the assistant overview page —
 * the replacement for the old About Assistant tab bar. Paths come from the
 * shared `ABOUT_ASSISTANT_SECTIONS` registry in `utils/routes.ts`; this
 * module owns overview-specific ordering and the translated label /
 * description pairs. Pure so the section list is unit-testable without
 * rendering the overview.
 */

import { t } from "@/i18n";
import { aboutAssistantSection, routes } from "@/utils/routes";

export interface IdentitySection {
  key: string;
  label: string;
  /** One playful line under the label — written in the assistant's voice. */
  description: string;
  to: string;
  /** The section is on a plan the org is not on; the card says so with a lock. */
  locked?: boolean;
}

type IdentitySectionKey =
  | "personality"
  | "schedules"
  | "superpowers"
  | "library"
  | "workspace"
  | "contacts"
  | "email"
  | "channels";

/** Greppable label/description keys, one entry per overview section. */
const SECTION_COPY_KEY: Record<
  IdentitySectionKey,
  {
    label: `identitySections.${IdentitySectionKey}.label`;
    description: `identitySections.${IdentitySectionKey}.description`;
  }
> = {
  personality: {
    label: "identitySections.personality.label",
    description: "identitySections.personality.description",
  },
  schedules: {
    label: "identitySections.schedules.label",
    description: "identitySections.schedules.description",
  },
  superpowers: {
    label: "identitySections.superpowers.label",
    description: "identitySections.superpowers.description",
  },
  library: {
    label: "identitySections.library.label",
    description: "identitySections.library.description",
  },
  workspace: {
    label: "identitySections.workspace.label",
    description: "identitySections.workspace.description",
  },
  contacts: {
    label: "identitySections.contacts.label",
    description: "identitySections.contacts.description",
  },
  email: {
    label: "identitySections.email.label",
    description: "identitySections.email.description",
  },
  channels: {
    label: "identitySections.channels.label",
    description: "identitySections.channels.description",
  },
};

/** Registry section's path + the overview's own translated label/description. */
function section(key: Exclude<IdentitySectionKey, "personality" | "email">) {
  const { to } = aboutAssistantSection(key);
  const copyKey = SECTION_COPY_KEY[key];
  return {
    key,
    label: t(copyKey.label, { ns: "intelligence" }),
    description: t(copyKey.description, { ns: "intelligence" }),
    to,
  } satisfies IdentitySection;
}

export interface BuildIdentitySectionsOptions {
  /**
   * Draw the Email card, after Channels. Absent where there is no inbox
   * to open (the flag is off, or the assistant is not platform-hosted):
   * the one section that depends on the platform, since the mail lives
   * there. `locked` marks a plan without managed email.
   */
  email?: { locked: boolean };
}

/**
 * Every section shows on every platform, the phone included. The overview
 * card is the way into a section, so a rough mobile surface is a reason to
 * polish it, not to hide it: an unpolished way in beats no way in. Email
 * is the exception, and only because the inbox itself does not exist off
 * the platform.
 */
export function buildIdentitySections({
  email,
}: BuildIdentitySectionsOptions = {}): IdentitySection[] {
  const emailSection: IdentitySection[] = email
    ? [
        {
          key: "email",
          label: t(SECTION_COPY_KEY.email.label, { ns: "intelligence" }),
          description: t(SECTION_COPY_KEY.email.description, {
            ns: "intelligence",
          }),
          to: routes.assistantInbox,
          locked: email.locked,
        },
      ]
    : [];
  return [
    // Personality renders bare (full-bleed stage chrome), so it is not a
    // registry section. The overview links it directly.
    {
      key: "personality",
      label: t(SECTION_COPY_KEY.personality.label, { ns: "intelligence" }),
      description: t(SECTION_COPY_KEY.personality.description, {
        ns: "intelligence",
      }),
      to: routes.personality,
    },
    section("schedules"),
    // Skills and plugins combined into one list; on assistants without the
    // plugin surface the page itself degrades to skills-only.
    section("superpowers"),
    // Library's list page wears the shared section chrome like its peers;
    // the app viewer (/assistant/library/:appId) renders full-bleed.
    section("library"),
    section("workspace"),
    section("contacts"),
    section("channels"),
    ...emailSection,
  ];
}
