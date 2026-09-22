/**
 * The people the Contacts list is read with, and the wrapper that owns the
 * filter text on their behalf, so its tests and its stories read the same list
 * through the same harness.
 */

import { type ComponentProps, type ReactNode, useState } from "react";

import { ContactsList } from "@/domains/contacts/components/contacts-list";
import type { ContactSummary } from "@/domains/contacts/types";

export const FIXTURE_GUARDIAN: ContactSummary = {
  id: "guardian-1",
  displayName: "Alice",
  role: "guardian",
  channelTypes: ["Telegram"],
};

/** Both contact types in both verification states, plus a multi-channel row. */
export const FIXTURE_CONTACTS: ContactSummary[] = [
  {
    id: "contact-bob",
    displayName: "Bob",
    role: "contact",
    contactType: "human",
    channelTypes: ["Telegram", "WhatsApp"],
    verified: true,
  },
  {
    id: "contact-carol",
    displayName: "Carol",
    role: "contact",
    contactType: "human",
    channelTypes: ["Email"],
    verified: false,
  },
  {
    id: "contact-dave",
    displayName: "Dave",
    role: "contact",
    contactType: "human",
    channelTypes: ["SMS"],
    verified: true,
  },
  {
    id: "contact-scheduler",
    displayName: "Scheduling Assistant",
    role: "contact",
    contactType: "assistant",
    channelTypes: ["A2A"],
    verified: true,
  },
  {
    id: "contact-research",
    displayName: "Research Assistant",
    role: "contact",
    contactType: "assistant",
    channelTypes: ["A2A"],
    verified: false,
  },
];

type ContactsListProps = ComponentProps<typeof ContactsList>;

/**
 * Holds the filter text the way the page does, seeded from `search`, so the
 * field narrows the rows instead of sitting inert. It answers the field itself,
 * so an `onSearchChange` that arrives with the rest of a story's args is
 * ignored.
 */
export function ContactsListWithSearch(
  props: Omit<ContactsListProps, "onSearchChange"> &
    Partial<Pick<ContactsListProps, "onSearchChange">>,
): ReactNode {
  const [search, setSearch] = useState(props.search);
  return <ContactsList {...props} search={search} onSearchChange={setSearch} />;
}
