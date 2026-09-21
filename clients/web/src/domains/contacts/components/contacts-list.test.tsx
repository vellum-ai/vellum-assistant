import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import type { ContactSummary } from "@/domains/contacts/types";

import { ContactsList } from "./contacts-list";

const GUARDIAN: ContactSummary = {
  id: "guardian-1",
  displayName: "Alice",
  role: "guardian",
  channelTypes: ["Telegram"],
};

const CONTACTS: ContactSummary[] = [
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
    id: "contact-peer",
    displayName: "Peer Assistant",
    role: "contact",
    contactType: "assistant",
    channelTypes: ["A2A"],
    verified: true,
  },
];

interface HarnessProps {
  surface?: "card" | "screen";
  guardian?: ContactSummary | null;
  regularContacts?: ContactSummary[];
  loading?: boolean;
  onSelect?: (contactId: string) => void;
}

/** Owns the search text the way the page does, so typing filters the rows. */
function Harness({
  surface = "card",
  guardian = GUARDIAN,
  regularContacts = CONTACTS,
  loading = false,
  onSelect = () => {},
}: HarnessProps) {
  const [search, setSearch] = useState("");
  return (
    <ContactsList
      loading={loading}
      guardian={guardian}
      regularContacts={regularContacts}
      selectedContactId={null}
      onSelect={onSelect}
      onAddContact={() => {}}
      surface={surface}
      search={search}
      onSearchChange={setSearch}
    />
  );
}

function rowButtons(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      'button[data-slot="panel-item"]',
    ),
  );
}

function rowByName(name: string): HTMLButtonElement {
  const row = rowButtons().find((button) =>
    (button.textContent ?? "").includes(name),
  );
  if (!row) {
    throw new Error(`No contact row for ${name}`);
  }
  return row;
}

/** The row's name line, which is the only span holding the name alone. */
function nameSpan(name: string): HTMLElement {
  const span = Array.from(
    rowByName(name).querySelectorAll<HTMLElement>("span"),
  ).find((candidate) => candidate.textContent === name);
  if (!span) {
    throw new Error(`No name span for ${name}`);
  }
  return span;
}

const NAME_COLOR_CLASS = "text-[var(--content-default)]";

function searchInput(): HTMLInputElement {
  return screen.getByPlaceholderText("Search Contacts") as HTMLInputElement;
}

function dividers(): Element[] {
  return Array.from(document.querySelectorAll(".border-t"));
}

afterEach(cleanup);

describe("ContactsList card surface", () => {
  test("renders the heading, the add button, and verification tags", () => {
    render(<Harness surface="card" />);

    expect(screen.getByText("Entries")).toBeTruthy();
    expect(screen.getByLabelText("Add contact")).toBeTruthy();
    expect(screen.getAllByText("Verified").length).toBe(2);
    expect(screen.getByText("Unverified")).toBeTruthy();
  });

  test("puts the search field after the guardian row", () => {
    render(<Harness surface="card" />);

    const position =
      rowByName("Alice (You)").compareDocumentPosition(searchInput());

    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
  });

  test("keeps the pencil and the overflow icon on the rows", () => {
    render(<Harness surface="card" />);

    expect(rowByName("Alice (You)").querySelectorAll("svg").length).toBe(1);
    expect(rowByName("Bob").querySelectorAll("svg").length).toBe(1);
  });

  test("leaves the row name at the panel row's resting color", () => {
    render(<Harness surface="card" />);

    expect(nameSpan("Bob").className).not.toContain(NAME_COLOR_CLASS);
    expect(nameSpan("Alice (You)").className).not.toContain(NAME_COLOR_CLASS);
  });
});

describe("ContactsList screen surface", () => {
  test("drops the card chrome, the verification tag, and the row icons", () => {
    render(<Harness surface="screen" />);

    expect(screen.queryByText("Entries")).toBeNull();
    expect(screen.queryByLabelText("Add contact")).toBeNull();
    expect(screen.queryByText("Verified")).toBeNull();
    expect(screen.queryByText("Unverified")).toBeNull();
    expect(rowByName("Alice (You)").querySelectorAll("svg").length).toBe(0);
    expect(rowByName("Bob").querySelectorAll("svg").length).toBe(0);
  });

  test("puts the search field before the guardian row", () => {
    render(<Harness surface="screen" />);

    const position = searchInput().compareDocumentPosition(
      rowByName("Alice (You)"),
    );

    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
  });

  test("trails every row with its type tag alone", () => {
    render(<Harness surface="screen" />);

    expect(screen.getByText("Guardian")).toBeTruthy();
    expect(screen.getAllByText("Human").length).toBe(2);
    expect(screen.getByText("Assistant")).toBeTruthy();
  });

  test("joins a contact's channels into the subtitle", () => {
    render(<Harness surface="screen" />);

    expect(rowByName("Bob").textContent).toContain("Telegram | WhatsApp");
  });

  test("paints the row name at full strength and the subtitle muted", () => {
    render(<Harness surface="screen" />);

    expect(nameSpan("Bob").className).toContain(NAME_COLOR_CLASS);
    expect(nameSpan("Alice (You)").className).toContain(NAME_COLOR_CLASS);
    expect(screen.getByText("Telegram | WhatsApp").style.color).toBe(
      "var(--content-tertiary)",
    );
  });

  test("renders every row as a button and reports the contact id", () => {
    const onSelect = mock((_contactId: string) => {});
    render(<Harness surface="screen" onSelect={onSelect} />);

    const rows = Array.from(
      document.querySelectorAll('[data-slot="panel-item"]'),
    );
    expect(rows.length).toBe(4);
    expect(rows.every((row) => row.tagName === "BUTTON")).toBe(true);

    fireEvent.click(rowByName("Carol"));

    expect(onSelect).toHaveBeenCalledWith("contact-carol");
  });

  test("narrows the contacts on search and keeps the guardian row", () => {
    render(<Harness surface="screen" />);

    fireEvent.change(searchInput(), { target: { value: "bo" } });

    expect(rowByName("Alice (You)")).toBeTruthy();
    expect(rowByName("Bob")).toBeTruthy();
    expect(rowButtons().length).toBe(2);
  });

  test("explains a search with no hits", () => {
    render(<Harness surface="screen" />);

    fireEvent.change(searchInput(), { target: { value: "zzz" } });

    expect(screen.getByText("No matching contacts")).toBeTruthy();
  });

  test("offers to add a contact when the loaded list is empty", () => {
    render(<Harness surface="screen" regularContacts={[]} />);

    expect(screen.getByText("Add Contact")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Search Contacts")).toBeNull();
  });
});

describe.each(["card", "screen"] as const)(
  "ContactsList %s surface without a guardian",
  (surface) => {
    test("renders neither the guardian row nor the group divider", () => {
      render(<Harness surface={surface} guardian={null} />);

      expect(dividers().length).toBe(0);
      expect(rowButtons().length).toBe(CONTACTS.length);
    });

    test("renders the group divider once with a guardian", () => {
      render(<Harness surface={surface} />);

      expect(dividers().length).toBe(1);
    });
  },
);
