import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  ContactsListWithSearch,
  FIXTURE_CONTACTS,
  FIXTURE_GUARDIAN,
} from "@/domains/contacts/components/contacts-list-fixtures";

import { ContactsList } from "./contacts-list";

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
    guardian: FIXTURE_GUARDIAN,
    regularContacts: FIXTURE_CONTACTS,
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
 * the contacts, each trailing only its type tag. No row is selected, because
 * the page holds the selection at null while the list is the screen, and the
 * 12px gutter is the `max-md:px-3` the page's shell insets the list by.
 */
export const Screen: Story = {
  args: { surface: "screen", selectedContactId: null },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  decorators: [
    (Story) => (
      <div style={{ padding: "16px 12px" }}>
        <Story />
      </div>
    ),
  ],
};
