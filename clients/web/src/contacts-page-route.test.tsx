/**
 * The contact id in the URL is not assistant-scoped, and the desktop host
 * switches assistants without navigating, so the route wrapper is what
 * returns an open contact to the list when the active assistant changes.
 *
 * `ContactsPage` is stubbed: these tests are about the wrapper's navigation,
 * not the page's rendering.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

import {
  currentLocation,
  LocationProbe,
} from "@/hooks/router-probe.test-helper";

const ALICE_ASSISTANT = "asst-alice";
const BOB_ASSISTANT = "asst-bob";

let activeAssistantId = ALICE_ASSISTANT;

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => activeAssistantId,
}));

mock.module("@/domains/contacts/contacts-page", () => ({
  ContactsPage: ({ assistantId }: { assistantId: string }) => (
    <div data-testid="contacts-page">{assistantId}</div>
  ),
}));

const { ContactsPageRoute } = await import("@/contacts-page-route");

/** The production route shape: two siblings sharing one component. */
function Tree({ initialPath }: { initialPath: string }) {
  const screenElement = (
    <>
      <ContactsPageRoute />
      <LocationProbe />
    </>
  );
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/assistant/contacts" element={screenElement} />
        <Route path="/assistant/contacts/:contactId" element={screenElement} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  activeAssistantId = ALICE_ASSISTANT;
});

afterEach(() => {
  cleanup();
});

describe("ContactsPageRoute assistant scoping", () => {
  test("a deep link into the active assistant stays on its contact", async () => {
    render(<Tree initialPath="/assistant/contacts/c-1" />);

    await waitFor(() => screen.getByTestId("contacts-page"));
    expect(currentLocation().pathname).toBe("/assistant/contacts/c-1");
  });

  test("switching assistants on a contact returns to the list", async () => {
    const { rerender } = render(<Tree initialPath="/assistant/contacts/c-1" />);

    await waitFor(() => screen.getByTestId("contacts-page"));

    activeAssistantId = BOB_ASSISTANT;
    rerender(<Tree initialPath="/assistant/contacts/c-1" />);

    await waitFor(() => {
      expect(currentLocation().pathname).toBe("/assistant/contacts");
    });
  });

  test("switching assistants on the list leaves the location alone", async () => {
    const { rerender } = render(<Tree initialPath="/assistant/contacts" />);

    await waitFor(() => screen.getByTestId("contacts-page"));

    activeAssistantId = BOB_ASSISTANT;
    rerender(<Tree initialPath="/assistant/contacts" />);

    await waitFor(() => {
      expect(screen.getByTestId("contacts-page").textContent).toBe(
        BOB_ASSISTANT,
      );
    });
    expect(currentLocation().pathname).toBe("/assistant/contacts");
  });
});
