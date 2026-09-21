/**
 * The contact id in the URL is not assistant-scoped, and the desktop host
 * switches assistants without navigating, so the route wrapper is what
 * returns an open contact to the list when the active assistant changes.
 *
 * `ContactsPage` is stubbed: these tests are about the wrapper's navigation,
 * not the page's rendering. The active id is served through a subscribable
 * stand-in, the way the real store-backed hook behaves, so a switch
 * re-renders the wrapper without remounting the tree it navigates in.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { RouterProvider, type InitialEntry } from "react-router";

import {
  createProbedRouter,
  currentLocation,
} from "@/hooks/router-probe.test-helper";
import { PUSHED_FROM_LIST_STATE } from "@/utils/list-detail-navigation";
import { routes } from "@/utils/routes";

const ALICE_ASSISTANT = "asst-alice";
const BOB_ASSISTANT = "asst-bob";

/** The production route shape: two siblings sharing one component. */
const CONTACTS_ROUTE_PATHS = [
  routes.contacts.root,
  `${routes.contacts.root}/:contactId`,
];

let activeAssistantId = ALICE_ASSISTANT;
const activeAssistantListeners = new Set<() => void>();

function setActiveAssistant(assistantId: string): void {
  activeAssistantId = assistantId;
  for (const notify of activeAssistantListeners) {
    notify();
  }
}

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () =>
    useSyncExternalStore(
      (onStoreChange: () => void) => {
        activeAssistantListeners.add(onStoreChange);
        return () => activeAssistantListeners.delete(onStoreChange);
      },
      () => activeAssistantId,
    ),
}));

mock.module("@/domains/contacts/contacts-page", () => ({
  ContactsPage: ({ assistantId }: { assistantId: string }) => (
    <div data-testid="contacts-page">{assistantId}</div>
  ),
}));

const { ContactsPageRoute } = await import("@/contacts-page-route");

function renderRoute(initialEntries: InitialEntry[], initialIndex?: number) {
  const router = createProbedRouter({
    paths: CONTACTS_ROUTE_PATHS,
    element: <ContactsPageRoute />,
    initialEntries,
    initialIndex,
  });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  activeAssistantId = ALICE_ASSISTANT;
});

afterEach(() => {
  cleanup();
  activeAssistantListeners.clear();
});

describe("ContactsPageRoute assistant scoping", () => {
  test("a deep link into the active assistant stays on its contact", async () => {
    renderRoute(["/assistant/contacts/c-1"]);

    await waitFor(() => screen.getByTestId("contacts-page"));
    expect(currentLocation().pathname).toBe("/assistant/contacts/c-1");
  });

  test("switching assistants on a contact returns to the list", async () => {
    renderRoute(["/assistant/contacts/c-1"]);

    await waitFor(() => screen.getByTestId("contacts-page"));

    act(() => {
      setActiveAssistant(BOB_ASSISTANT);
    });

    await waitFor(() => {
      expect(currentLocation().pathname).toBe("/assistant/contacts");
    });
  });

  test("switching assistants on the list leaves the location alone", async () => {
    renderRoute(["/assistant/contacts"]);

    await waitFor(() => screen.getByTestId("contacts-page"));

    act(() => {
      setActiveAssistant(BOB_ASSISTANT);
    });

    await waitFor(() => {
      expect(screen.getByTestId("contacts-page").textContent).toBe(
        BOB_ASSISTANT,
      );
    });
    expect(currentLocation().pathname).toBe("/assistant/contacts");
  });

  test("switching assistants on a contact pushed from the list pops it", async () => {
    const router = renderRoute(
      [
        "/assistant/contacts",
        { pathname: "/assistant/contacts/c-1", state: PUSHED_FROM_LIST_STATE },
      ],
      1,
    );

    await waitFor(() => screen.getByTestId("contacts-page"));

    act(() => {
      setActiveAssistant(BOB_ASSISTANT);
    });

    await waitFor(() => {
      expect(currentLocation().pathname).toBe("/assistant/contacts");
    });

    // Popped rather than replaced: the detail is still ahead, so the stack
    // never gained a second copy of the list for Back to land on.
    await act(async () => {
      await router.navigate(1);
    });
    expect(currentLocation().pathname).toBe("/assistant/contacts/c-1");
  });

  test("switching assistants on a deep-linked contact replaces its entry", async () => {
    const router = renderRoute(
      ["/assistant/contacts", "/assistant/contacts/c-1"],
      1,
    );

    await waitFor(() => screen.getByTestId("contacts-page"));

    act(() => {
      setActiveAssistant(BOB_ASSISTANT);
    });

    await waitFor(() => {
      expect(currentLocation().pathname).toBe("/assistant/contacts");
    });

    // The entry carried no marker, so nothing was popped and the list sits
    // where the contact did, with nothing ahead of it.
    await act(async () => {
      await router.navigate(1);
    });
    expect(currentLocation().pathname).toBe("/assistant/contacts");
  });
});
