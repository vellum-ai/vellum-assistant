import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, type ReactNode, useState } from "react";

import type { ContactSummary } from "@/domains/contacts/types";

import { ContactsList } from "./contacts-list";

/**
 * The page owns the filter text, so the story owns it too and the field filters
 * instead of sitting inert.
 */
function ContactsListWithSearch(
  props: ComponentProps<typeof ContactsList>,
): ReactNode {
  const [search, setSearch] = useState(props.search);
  return <ContactsList {...props} search={search} onSearchChange={setSearch} />;
}

/**
 * The Contacts list in both places it is mounted: the `card` surface that sits
 * in the desktop rail and the narrow-pane drawer, and the flat `screen` surface
 * that is the phone page itself.
 */
const meta: Meta<typeof ContactsList> = {
  title: "Contacts/ContactsList",
  component: ContactsList,
  args: {
    loading: false,
    guardian: {
      id: "guardian-1",
      displayName: "Alice",
      role: "guardian",
      channelTypes: ["Telegram"],
    },
    regularContacts: [
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
    ] satisfies ContactSummary[],
    selectedContactId: "contact-bob",
    onSelect: () => {},
    onAddContact: () => {},
    search: "",
    onSearchChange: () => {},
  },
  render: (args) => <ContactsListWithSearch {...args} />,
};

export default meta;

type Story = StoryObj<typeof ContactsList>;

/** The rail and drawer surface: a card, a heading row, and its own plus. */
export const Card: Story = {
  args: { surface: "card" },
  decorators: [
    (Story) => (
      <div style={{ width: 320, height: 520 }}>
        <Story />
      </div>
    ),
  ],
};

/**
 * The phone page: a 40px search field first, the guardian row, a divider, then
 * the contacts, each trailing only its type tag.
 */
export const Screen: Story = {
  args: { surface: "screen" },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  decorators: [
    (Story) => (
      <div style={{ padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};
