/**
 * The contact id in the URL is not assistant-scoped, and the desktop host
 * switches assistants without navigating, so the route wrapper is what
 * returns an open contact to the list when the active assistant changes.
 *
 * `ContactsPage` is stubbed: these tests are about the wrapper's navigation,
 * not the page's rendering.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useNavigate,
  type InitialEntry,
} from "react-router";

import {
  currentLocation,
  LocationProbe,
} from "@/hooks/router-probe.test-helper";
import { PUSHED_FROM_LIST_STATE } from "@/utils/list-detail-navigation";

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

/**
 * Walks the mounted tree's history stack, so a test can tell a popped entry
 * from a replaced one: only a pop leaves the detail ahead of the list.
 */
let goInHistory: (delta: number) => void = () => {};

function HistoryProbe(): null {
  const navigate = useNavigate();
  useEffect(() => {
    goInHistory = (delta) => {
      void navigate(delta);
    };
  }, [navigate]);
  return null;
}

/** The production route shape: two siblings sharing one component. */
function Tree({
  initialEntries,
  initialIndex,
}: {
  initialEntries: InitialEntry[];
  initialIndex?: number;
}) {
  const screenElement = (
    <>
      <ContactsPageRoute />
      <LocationProbe />
      <HistoryProbe />
    </>
  );
  return (
    <MemoryRouter initialEntries={initialEntries} initialIndex={initialIndex}>
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
    render(<Tree initialEntries={["/assistant/contacts/c-1"]} />);

    await waitFor(() => screen.getByTestId("contacts-page"));
    expect(currentLocation().pathname).toBe("/assistant/contacts/c-1");
  });

  test("switching assistants on a contact returns to the list", async () => {
    const { rerender } = render(
      <Tree initialEntries={["/assistant/contacts/c-1"]} />,
    );

    await waitFor(() => screen.getByTestId("contacts-page"));

    activeAssistantId = BOB_ASSISTANT;
    rerender(<Tree initialEntries={["/assistant/contacts/c-1"]} />);

    await waitFor(() => {
      expect(currentLocation().pathname).toBe("/assistant/contacts");
    });
  });

  test("switching assistants on the list leaves the location alone", async () => {
    const { rerender } = render(
      <Tree initialEntries={["/assistant/contacts"]} />,
    );

    await waitFor(() => screen.getByTestId("contacts-page"));

    activeAssistantId = BOB_ASSISTANT;
    rerender(<Tree initialEntries={["/assistant/contacts"]} />);

    await waitFor(() => {
      expect(screen.getByTestId("contacts-page").textContent).toBe(
        BOB_ASSISTANT,
      );
    });
    expect(currentLocation().pathname).toBe("/assistant/contacts");
  });

  test("switching assistants on a contact pushed from the list pops it", async () => {
    const entries: InitialEntry[] = [
      "/assistant/contacts",
      { pathname: "/assistant/contacts/c-1", state: PUSHED_FROM_LIST_STATE },
    ];
    const { rerender } = render(
      <Tree initialEntries={entries} initialIndex={1} />,
    );

    await waitFor(() => screen.getByTestId("contacts-page"));

    activeAssistantId = BOB_ASSISTANT;
    rerender(<Tree initialEntries={entries} initialIndex={1} />);

    await waitFor(() => {
      expect(currentLocation().pathname).toBe("/assistant/contacts");
    });

    // Popped rather than replaced: the detail is still ahead, so the stack
    // never gained a second copy of the list for Back to land on.
    act(() => {
      goInHistory(1);
    });
    expect(currentLocation().pathname).toBe("/assistant/contacts/c-1");
  });

  test("switching assistants on a deep-linked contact replaces its entry", async () => {
    const entries: InitialEntry[] = [
      "/assistant/contacts",
      "/assistant/contacts/c-1",
    ];
    const { rerender } = render(
      <Tree initialEntries={entries} initialIndex={1} />,
    );

    await waitFor(() => screen.getByTestId("contacts-page"));

    activeAssistantId = BOB_ASSISTANT;
    rerender(<Tree initialEntries={entries} initialIndex={1} />);

    await waitFor(() => {
      expect(currentLocation().pathname).toBe("/assistant/contacts");
    });

    // The entry carried no marker, so nothing was popped and the list sits
    // where the contact did, with nothing ahead of it.
    act(() => {
      goInHistory(1);
    });
    expect(currentLocation().pathname).toBe("/assistant/contacts");
  });
});
