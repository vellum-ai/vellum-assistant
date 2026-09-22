/**
 * A failing contact mutation (e.g. a gateway 404) must surface as a toast
 * and must not escalate to an unhandled promise rejection.
 *
 * Drives the real `ContactsPage` (real `@tanstack/react-query`) so the
 * actual mutation wiring is exercised; only the gateway, the generated
 * query layer, and `toast` are mocked. Mirrors the mocking style in
 * `domains/settings/ai/provider-create-form.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import {
  createElement,
  isValidElement,
  type ReactElement,
  useState,
} from "react";
import {
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  useLocation,
} from "react-router";

import { useIntelligenceLayoutSlotsStore } from "@/components/layout/intelligence-layout-slots-store";
import { ApiError } from "@/utils/api-errors";
import { DRAFT_CONTACT_NAME } from "@/domains/contacts/draft-contact";
import type { ChannelInfo, ContactPayload } from "@/domains/contacts/types";
import {
  createProbedRouter,
  currentLocation,
} from "@/hooks/router-probe.test-helper";
import * as rqGen from "@/generated/daemon/@tanstack/react-query.gen";
import * as sdkGen from "@/generated/daemon/sdk.gen";
import type { UseEdgeSwipeBackArgs } from "@/hooks/use-edge-swipe-back";
import * as useIsMobileModule from "@/hooks/use-is-mobile";
import { routes } from "@/utils/routes";

// ---------------------------------------------------------------------------
// Module-level holders
// ---------------------------------------------------------------------------

let toastErrorCalls: string[] = [];
let upsertShouldReject = false;
let lastUpsertBody: unknown = null;
let contactsFixture: ContactPayload[] = [];
let contactsShouldReject = false;
let availableChannelsOverride: ChannelInfo[] | null = null;
let isMobile = false;
let hasRoomForList = true;
let lastSwipeArgs: UseEdgeSwipeBackArgs | null = null;
/** Holds delete requests open so the detail's pending state is observable. */
let holdDelete = false;
/** One resolver per held contact id, so two deletes can overlap. */
const heldDeletes = new Map<string, () => void>();
/** Holds upserts open so a save's pending state is observable. */
let holdUpsert = false;
/** One resolver per held contact id, keyed the way `heldDeletes` is. */
const heldUpserts = new Map<string, () => void>();
const linkAndVerifyCalls: Array<{ type: string; address: string }> = [];
const mergeRequests: Array<{ keepId: string; mergeId: string }> = [];
const unhandledRejections: unknown[] = [];

const GUARDIAN = {
  id: "c-guardian",
  role: "guardian",
  displayName: "Example User",
  notes: "",
  channels: [],
  interactionCount: 0,
  contactType: null,
} as unknown as ContactPayload;

const ALICE = {
  id: "c-alice",
  role: "contact",
  displayName: "Alice",
  notes: "",
  channels: [],
  interactionCount: 0,
  contactType: "human",
  autoApproveThreshold: null,
} as unknown as ContactPayload;

/** A second human contact, so a Permissions picker other than Alice's exists. */
const BOB: ContactPayload = { ...ALICE, id: "c-bob", displayName: "Bob" };

const PEER = {
  id: "c-peer",
  role: "contact",
  displayName: "Peer Assistant",
  notes: "",
  channels: [],
  interactionCount: 0,
  contactType: "assistant",
  autoApproveThreshold: null,
} as unknown as ContactPayload;

const DRAFT: ContactPayload = {
  ...ALICE,
  id: "c-draft",
  displayName: DRAFT_CONTACT_NAME,
};

const CONTACTS_KEY = ["contactsGet", "test"] as const;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: () => {},
    error: (message: string) => {
      toastErrorCalls.push(message);
    },
  },
  Toaster: () => null,
  ToastContent: () => null,
}));

mock.module("@vellumai/design-library/components/select", () => ({
  Select: ({
    value,
    onChange,
    onSelectNone,
    options,
    disabled,
  }: {
    value: string | null;
    onChange: (value: string) => void;
    onSelectNone?: () => void;
    options: Array<{ value: string | null; label: string }>;
    disabled?: boolean;
  }) =>
    createElement(
      "select",
      {
        "data-testid": "contact-permissions-select",
        disabled,
        value: value ?? "",
        onChange: (event: { target: { value: string } }) => {
          const next = event.target.value;
          if (next === "") {
            onSelectNone?.();
            return;
          }
          onChange(next);
        },
      },
      options.map((option) =>
        createElement(
          "option",
          { key: option.value ?? "inherit", value: option.value ?? "" },
          option.label,
        ),
      ),
    ),
}));

// The two axes the page reads to choose between a rail, a drawer, and the
// list as the page. Both default to what a desktop window reports, so a suite
// that sets neither keeps the desktop path. The real module is copied before
// the mock is registered, since reading it afterwards yields the mock.
const realUseIsMobileModule = { ...useIsMobileModule };

mock.module("@/hooks/use-is-mobile", () => ({
  ...realUseIsMobileModule,
  useIsMobile: () => isMobile,
}));

// Captures the registration instead of installing the real document-level
// gesture, so the suite can read what the page asks for without synthesising
// touches.
mock.module("@/hooks/use-edge-swipe-back", () => ({
  useEdgeSwipeBack: (args: UseEdgeSwipeBackArgs) => {
    lastSwipeArgs = args;
  },
}));

mock.module("@/hooks/use-side-list-room", () => ({
  useSideListRoom: () => {
    const [drawerOpen, setDrawerOpen] = useState(false);
    return {
      paneRef: () => {},
      hasRoomForList,
      drawerOpen,
      openDrawer: () => setDrawerOpen(true),
      closeDrawer: () => setDrawerOpen(false),
    };
  },
}));

mock.module("@/domains/contacts/contacts-gateway", () => ({
  upsertContact: async (
    _assistantId: string,
    body: {
      id?: string;
      displayName: string;
      autoApproveThreshold?: ContactPayload["autoApproveThreshold"];
    },
  ) => {
    lastUpsertBody = body;
    if (upsertShouldReject) {
      throw new ApiError(404, "Not found");
    }
    // A create carries no id, so it is held under the one the daemon answers
    // with, which is what `releaseUpsert` is given.
    const heldId = body.id ?? DRAFT.id;
    if (holdUpsert) {
      await new Promise<void>((resolve) => {
        heldUpserts.set(heldId, resolve);
      });
    }
    if (!body.id) {
      return { ...DRAFT, displayName: body.displayName };
    }
    if (body.id === ALICE.id) {
      return { ...ALICE, ...body };
    }
    if (body.id === PEER.id) {
      return { ...PEER, ...body };
    }
    return { ...GUARDIAN, ...body };
  },
  deleteContact: async (_assistantId: string, contactId: string) => {
    if (!holdDelete) {
      return;
    }
    await new Promise<void>((resolve) => {
      heldDeletes.set(contactId, resolve);
    });
  },
  verifyContactChannel: async () => {},
  linkContactChannelAccount: async (
    _assistantId: string,
    _contact: { id: string; displayName: string },
    channel: { type: string; address: string },
  ) => {
    linkAndVerifyCalls.push(channel);
    return GUARDIAN;
  },
  redeemA2AInvite: async () => ({ success: true }),
}));

// Resolve every query the page renders to a fixture so the detail pane rests
// on the guardian and no real network is attempted. Real mutation hooks (merge
// and channel-patch) are kept, so the merge is driven through its generated
// hook and stubbed one level down, at its SDK call.
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...rqGen,
  contactsGetOptions: () => ({
    queryKey: CONTACTS_KEY,
    queryFn: async () => {
      if (contactsShouldReject) {
        throw new ApiError(500, "Contacts unavailable");
      }
      return { contacts: contactsFixture };
    },
  }),
  contactsGetQueryKey: () => CONTACTS_KEY,
  contactsGetSetQueryData: () => {},
  channelsReadinessGetOptions: () => ({
    queryKey: ["channelsReadiness", "test"],
    queryFn: async () => ({ snapshots: [] }),
  }),
  channelsReadinessGetQueryKey: () => ["channelsReadiness", "test"],
  channelsAvailableGetOptions: () => ({
    queryKey: ["channelsAvailable", "test"],
  }),
  integrationsSlackChannelConfigGetOptions: () => ({
    queryKey: ["slackConfig", "test"],
    queryFn: async () => ({ threadMode: "single" }),
  }),
  integrationsSlackChannelConfigGetQueryKey: () => ["slackConfig", "test"],
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  // The daemon answers a merge with the surviving contact, which is the one
  // named by `keepId`.
  contactsMergePost: async (options: {
    body: { keepId: string; mergeId: string };
  }) => {
    mergeRequests.push(options.body);
    return {
      data: {
        contact: contactsFixture.find((c) => c.id === options.body.keepId),
      },
      error: undefined,
      response: { ok: true, status: 200 },
    };
  },
  channelsAvailableGet: async () => {
    if (availableChannelsOverride) {
      return {
        data: { channels: availableChannelsOverride },
        error: undefined,
        response: { ok: true, status: 200 },
      };
    }
    return {
      data: undefined,
      error: undefined,
      response: { ok: false, status: 404 },
    };
  },
}));

const { ContactsPage } = await import("@/domains/contacts/contacts-page");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pass `seededContacts` to stand in for cached data a mount would revalidate:
 * the query reads it immediately and refetches in the background. A
 * `staleTime` makes that seeded cache fresh instead, so the mount serves it
 * and never refetches, which is what production's global `staleTime` does.
 */
function makeQueryClient(
  seededContacts?: ContactPayload[],
  options?: { staleTime?: number },
): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: options?.staleTime },
      mutations: { retry: false },
    },
  });
  if (seededContacts) {
    client.setQueryData(CONTACTS_KEY, { contacts: seededContacts });
  }
  return client;
}

/** The production route shape: two sibling entries sharing one component. */
const CONTACTS_ROUTE_PATHS = [
  routes.contacts.root,
  `${routes.contacts.root}/:contactId`,
];

/**
 * A route outside Contacts, so a test can leave the page (unmounting it) and
 * still read where the router ends up.
 */
const AWAY_PATH = routes.library.root;

/**
 * Renders the page under that shape, so `useParams` yields `contactId` and a
 * step between list and detail keeps the page mounted. Returns the router the
 * suite reads its entry from and walks back with, plus the render's `unmount`.
 */
function renderContactsPage(options?: {
  initialPath?: string;
  queryClient?: QueryClient;
  onStartSetupConversation?: (prompt: string) => void;
}) {
  const router = createProbedRouter({
    paths: CONTACTS_ROUTE_PATHS,
    element: (
      <ContactsPage
        assistantId="asst-1"
        onStartSetupConversation={options?.onStartSetupConversation}
      />
    ),
    initialEntries: [options?.initialPath ?? "/assistant/contacts"],
    awayPaths: [AWAY_PATH],
  });

  const { unmount } = render(
    <QueryClientProvider client={options?.queryClient ?? makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return { router, unmount };
}

/**
 * Merges the peer contact into whichever contact the detail view has open, and
 * returns once the success path has fully landed. Three signals, in order: the
 * request reaches the SDK, the handler that runs on its response closes the
 * dialog, and a data router resolves the navigation that handler may have
 * asked for a tick later. Only past the last one does the location read true.
 */
async function mergePeerIntoOpenContact(): Promise<void> {
  fireEvent.click(getButton("Merge…"));
  fireEvent.click(await waitFor(() => getModalButton(PEER.displayName)));
  fireEvent.click(await waitFor(() => getModalButton("Merge")));
  await waitFor(() => {
    expect(mergeRequests).toEqual([{ keepId: ALICE.id, mergeId: PEER.id }]);
  });
  await waitFor(() => {
    expect(document.querySelector('[data-slot="modal-content"]')).toBe(null);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function queryInputByPlaceholder(placeholder: string): HTMLInputElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(
      (el) => el.placeholder === placeholder,
    ) ?? null
  );
}

function getInputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = queryInputByPlaceholder(placeholder);
  if (!input) {
    throw new Error(`expected an input with placeholder "${placeholder}"`);
  }
  return input;
}

/** The add action the page hangs off the layout's mobile top bar. */
function headerTrailing(): ReactElement<{ onClick: () => void }> | null {
  const node = useIntelligenceLayoutSlotsStore.getState().headerTrailing;
  return isValidElement(node)
    ? (node as ReactElement<{ onClick: () => void }>)
    : null;
}

/** What the page reports to the layout about the open contact's depth. */
function detailIsScreen(): boolean {
  return useIntelligenceLayoutSlotsStore.getState().detailIsScreen;
}

function queryDrawerTrigger(): Element | null {
  return document.querySelector('[aria-label="Open sidebar"]');
}

/** The detail pane's spinner, shown while the pane has nothing to say yet. */
function queryPaneSpinner(): Element | null {
  return document.querySelector("section svg.animate-spin");
}

function getButton(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === label);
  if (!match) {
    throw new Error(`expected a "${label}" button`);
  }
  return match;
}

/** Lets one held delete finish and settles the renders it causes. */
async function releaseDelete(contactId: string): Promise<void> {
  const resolve = heldDeletes.get(contactId);
  if (!resolve) {
    throw new Error(`expected a held delete for "${contactId}"`);
  }
  heldDeletes.delete(contactId);
  await act(async () => {
    resolve();
    await new Promise((settle) => setTimeout(settle, 0));
  });
}

/**
 * Taps the list screen's add action and returns once the create is open at
 * the gateway, so the caller can decide where the user is when it lands.
 * Requires `holdUpsert`.
 */
async function startAddFromTopBar(): Promise<void> {
  await waitFor(() => getInputByPlaceholder("Search Contacts"));
  const addAction = headerTrailing();
  if (!addAction) {
    throw new Error("expected the top bar add action");
  }
  await act(async () => {
    addAction.props.onClick();
  });
  await waitFor(() => {
    expect(heldUpserts.has(DRAFT.id)).toBe(true);
  });
}

/** Leaves Contacts for a route that mounts no page, unmounting the page. */
async function leaveContacts(
  router: ReturnType<typeof createProbedRouter>,
): Promise<void> {
  await act(async () => {
    await router.navigate(AWAY_PATH);
  });
  expect(currentLocation().pathname).toBe(AWAY_PATH);
  expect(queryInputByPlaceholder("Search Contacts")).toBe(null);
}

/** Lets one held upsert finish and settles the renders it causes. */
async function releaseUpsert(contactId: string): Promise<void> {
  const resolve = heldUpserts.get(contactId);
  if (!resolve) {
    throw new Error(`expected a held upsert for "${contactId}"`);
  }
  heldUpserts.delete(contactId);
  await act(async () => {
    resolve();
    await new Promise((settle) => setTimeout(settle, 0));
  });
}

/** The auto-approve threshold picker, standing in for the design-library Select. */
function getPermissionsSelect(): HTMLSelectElement {
  const node = document.querySelector(
    '[data-testid="contact-permissions-select"]',
  );
  if (!(node instanceof HTMLSelectElement)) {
    throw new Error("expected the permissions picker");
  }
  return node;
}

/** The names the merge dialog is currently offering as donors. */
function mergeCandidateLabels(): string[] {
  return Array.from(
    document.querySelectorAll('[data-slot="modal-content"] [role="option"]'),
  ).map((option) => option.textContent?.trim() ?? "");
}

function getModalButton(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-slot="modal-content"] button',
    ),
  ).find((button) => button.textContent?.trim() === label);
  if (!match) {
    throw new Error(`expected a "${label}" button inside a modal`);
  }
  return match;
}

function onUnhandled(reason: unknown) {
  unhandledRejections.push(reason);
}

function getButtonByText(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.textContent?.includes(label));
  if (!match) {
    throw new Error(`expected a button containing "${label}"`);
  }
  return match;
}

beforeEach(() => {
  toastErrorCalls = [];
  upsertShouldReject = false;
  lastUpsertBody = null;
  contactsFixture = [GUARDIAN, ALICE, PEER];
  contactsShouldReject = false;
  availableChannelsOverride = null;
  isMobile = false;
  hasRoomForList = true;
  lastSwipeArgs = null;
  linkAndVerifyCalls.length = 0;
  mergeRequests.length = 0;
  unhandledRejections.length = 0;
  holdDelete = false;
  heldDeletes.clear();
  holdUpsert = false;
  heldUpserts.clear();
  useIntelligenceLayoutSlotsStore.getState().setHeaderTrailing(null);
  useIntelligenceLayoutSlotsStore.getState().setDetailIsScreen(false);
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  cleanup();
  // The online manager is a module singleton, so an offline test would
  // otherwise leave every later query paused.
  onlineManager.setOnline(true);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContactsPage legacy setup deep link", () => {
  test("?setup= deep link redirects to the Channels tab with the param intact", async () => {
    // Old builds' mobile chat handoff (and saved links) pointed channel
    // setup at this page; the credential forms now live only on the
    // Channels tab, so the page must forward the link there.
    function ChannelsMarker() {
      const location = useLocation();
      return createElement(
        "div",
        { "data-testid": "channels-page" },
        location.search,
      );
    }

    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/assistant/contacts?setup=slack"] },
        createElement(
          QueryClientProvider,
          { client: makeQueryClient() },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: "/assistant/contacts",
              element: createElement(ContactsPage, { assistantId: "asst-1" }),
            }),
            createElement(Route, {
              path: "/assistant/channels",
              element: createElement(ChannelsMarker),
            }),
          ),
        ),
      ),
    );

    await waitFor(() => {
      const marker = document.querySelector('[data-testid="channels-page"]');
      expect(marker).not.toBeNull();
      expect(marker!.textContent).toBe("?setup=slack");
    });
  });
});

describe("ContactsPage mutation error handling", () => {
  test("a failed contact save surfaces a toast and does not reject", async () => {
    upsertShouldReject = true;

    renderContactsPage();

    // The pane rests on the guardian, rendering its editable Name field.
    const nameInput = await waitFor(() => getInputByPlaceholder("Your name"));

    // Dirty the form so Save enables, then submit.
    fireEvent.change(nameInput, { target: { value: "Example Guardian" } });
    fireEvent.click(getButton("Save"));

    // The gateway 404 is surfaced to the user as a toast carrying the
    // server message...
    await waitFor(() => {
      expect(toastErrorCalls).toEqual(["Not found"]);
    });

    // ...and the rejection never escaped to window.onunhandledrejection.
    // `.mutate()` keeps it internal to React Query.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandledRejections).toEqual([]);
  });
});

describe("ContactsPage list and detail", () => {
  test("lists the guardian and the contacts, and no assistant row", async () => {
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));

    const buttonLabels = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).map((button) => button.textContent ?? "");
    expect(buttonLabels.some((label) => label.includes("your assistant"))).toBe(
      false,
    );
    expect(buttonLabels.some((label) => label.includes("Example User"))).toBe(
      true,
    );
    expect(buttonLabels.some((label) => label.includes("Alice"))).toBe(true);
    expect(buttonLabels.some((label) => label.includes("Peer Assistant"))).toBe(
      true,
    );
  });

  test("deleting the selected contact lands on the guardian", async () => {
    renderContactsPage();

    // The detail pane spins while contacts load: "Select a contact" is the
    // wrong copy before the guardian is known.
    expect(queryPaneSpinner()).not.toBe(null);
    expect(document.body.textContent).not.toContain("Select a contact");

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText("Alice"));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));

    fireEvent.click(getButton("Delete Contact"));
    fireEvent.click(await waitFor(() => getModalButton("Delete")));

    await waitFor(() => getInputByPlaceholder("Your name"));
    expect(currentLocation().pathname).toBe("/assistant/contacts");
  });

  test("a delete in flight keeps the contact on screen, showing its pending state", async () => {
    holdDelete = true;
    // A channel row, so the section's actions are on screen to be blocked.
    contactsFixture = [
      GUARDIAN,
      {
        ...ALICE,
        channels: [
          {
            id: "ch-phone",
            type: "phone",
            address: "+15555550100",
            status: "unverified",
          },
        ],
      } as unknown as ContactPayload,
      PEER,
    ];
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText("Alice"));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));

    fireEvent.click(getButton("Delete Contact"));
    fireEvent.click(await waitFor(() => getModalButton("Delete")));

    // The detail owns the waiting state; swapping it for the resting copy
    // would tell the user to select a contact they are in the middle of
    // deleting.
    const deleting = await waitFor(() => getButton("Deleting…"));
    expect(deleting.disabled).toBe(true);
    expect(getInputByPlaceholder("Give this human a name")).toBeDefined();
    expect(document.body.textContent).not.toContain("Select a contact");
    // Staying on screen means the channel actions are reachable, and they act
    // on the id the server is deleting.
    expect(getButton("Verify").disabled).toBe(true);
    // The threshold picker upserts that same id, so it is blocked too.
    expect(getPermissionsSelect().disabled).toBe(true);

    await releaseDelete(ALICE.id);

    await waitFor(() => getInputByPlaceholder("Your name"));
    expect(currentLocation().pathname).toBe("/assistant/contacts");
  });

  test("a delete in flight leaves every other contact interactive", async () => {
    holdDelete = true;
    // Bob is the human of the pair: only a human carries a Permissions
    // picker, so only Bob exercises the threshold gate.
    contactsFixture = [GUARDIAN, ALICE, BOB, PEER];
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText("Alice"));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));

    fireEvent.click(getButton("Delete Contact"));
    fireEvent.click(await waitFor(() => getModalButton("Delete")));
    await waitFor(() => getButton("Deleting…"));

    // Alice drops out of the list while the request is open, but the rest of
    // it stays reachable, so another contact can be opened mid-delete.
    fireEvent.click(getButtonByText("Peer Assistant"));
    await waitFor(() => {
      expect(currentLocation().pathname).toBe(`/assistant/contacts/${PEER.id}`);
    });

    expect(getButton("Delete Contact").disabled).toBe(false);
    expect(getInputByPlaceholder("Give this human a name").disabled).toBe(
      false,
    );

    fireEvent.click(getButtonByText(BOB.displayName));
    await waitFor(() => {
      expect(currentLocation().pathname).toBe(`/assistant/contacts/${BOB.id}`);
    });

    // The threshold picker upserts the id it belongs to, so Alice's delete
    // has no claim on it.
    expect(getPermissionsSelect().disabled).toBe(false);

    await releaseDelete(ALICE.id);
  });

  test("an earlier delete landing leaves the contact opened since alone", async () => {
    holdDelete = true;
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText("Alice"));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));

    fireEvent.click(getButton("Delete Contact"));
    fireEvent.click(await waitFor(() => getModalButton("Delete")));
    await waitFor(() => getButton("Deleting…"));

    fireEvent.click(getButtonByText("Peer Assistant"));
    await waitFor(() => {
      expect(currentLocation().pathname).toBe(`/assistant/contacts/${PEER.id}`);
    });
    const nameInput = getInputByPlaceholder("Give this human a name");
    fireEvent.change(nameInput, { target: { value: "Renamed Peer" } });

    await releaseDelete(ALICE.id);

    // Alice's delete must not walk the user off an unsaved edit to Peer.
    expect(currentLocation().pathname).toBe(`/assistant/contacts/${PEER.id}`);
    expect(getInputByPlaceholder("Give this human a name").value).toBe(
      "Renamed Peer",
    );
  });

  test("a second delete does not let the first contact back into the list", async () => {
    holdDelete = true;
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText("Alice"));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));

    fireEvent.click(getButton("Delete Contact"));
    fireEvent.click(await waitFor(() => getModalButton("Delete")));
    await waitFor(() => getButton("Deleting…"));

    fireEvent.click(getButtonByText("Peer Assistant"));
    await waitFor(() => {
      expect(currentLocation().pathname).toBe(`/assistant/contacts/${PEER.id}`);
    });
    fireEvent.click(getButton("Delete Contact"));
    fireEvent.click(await waitFor(() => getModalButton("Delete")));
    await waitFor(() => getButton("Deleting…"));

    // One mutation observer reports only the newest delete, so Alice would
    // otherwise reappear and be editable while her request is still open.
    expect(() => getButtonByText("Alice")).toThrow();

    await releaseDelete(ALICE.id);
    await releaseDelete(PEER.id);
  });
});

/**
 * Every mutation here is page-global, so each one has to name the contact it
 * belongs to. A request left open on one contact must not reach into another.
 */
describe("ContactsPage overlapping mutations", () => {
  test("a contact whose delete is in flight is not offered as a merge donor", async () => {
    holdDelete = true;
    contactsFixture = [GUARDIAN, ALICE, BOB, PEER];
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText(PEER.displayName));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));

    fireEvent.click(getButton("Delete Contact"));
    fireEvent.click(await waitFor(() => getModalButton("Delete")));
    await waitFor(() => getButton("Deleting…"));

    fireEvent.click(getButtonByText(ALICE.displayName));
    await waitFor(() => {
      expect(currentLocation().pathname).toBe(
        `/assistant/contacts/${ALICE.id}`,
      );
    });

    fireEvent.click(getButton("Merge…"));

    // Bob proves the picker rendered, so Peer's absence is the filter rather
    // than an empty list: picking Peer would race its open DELETE.
    await waitFor(() => {
      expect(mergeCandidateLabels()).toEqual([BOB.displayName]);
    });

    await releaseDelete(PEER.id);
  });

  test("a save in flight leaves another contact's form editable", async () => {
    holdUpsert = true;
    contactsFixture = [GUARDIAN, ALICE, BOB, PEER];
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText(ALICE.displayName));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));

    fireEvent.change(getInputByPlaceholder("Give this human a name"), {
      target: { value: "Renamed Alice" },
    });
    fireEvent.click(getButton("Save"));
    await waitFor(() => getButton("Saving…"));

    fireEvent.click(getButtonByText(BOB.displayName));
    await waitFor(() => {
      expect(currentLocation().pathname).toBe(`/assistant/contacts/${BOB.id}`);
    });

    // Alice's request is still open, and it is hers alone: Bob's form neither
    // reads as saving nor locks.
    expect(getButton("Save")).toBeDefined();
    expect(getInputByPlaceholder("Give this human a name").disabled).toBe(
      false,
    );

    await releaseUpsert(ALICE.id);
  });

  test("two overlapping saves each hold their own contact's form", async () => {
    holdUpsert = true;
    contactsFixture = [GUARDIAN, ALICE, BOB, PEER];
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText(ALICE.displayName));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    fireEvent.change(getInputByPlaceholder("Give this human a name"), {
      target: { value: "Renamed Alice" },
    });
    fireEvent.click(getButton("Save"));
    await waitFor(() => getButton("Saving…"));

    fireEvent.click(getButtonByText(BOB.displayName));
    await waitFor(() => {
      expect(currentLocation().pathname).toBe(`/assistant/contacts/${BOB.id}`);
    });
    fireEvent.change(getInputByPlaceholder("Give this human a name"), {
      target: { value: "Renamed Bob" },
    });
    fireEvent.click(getButton("Save"));
    await waitFor(() => getButton("Saving…"));

    // The observer describes only Bob's call, so Alice's open request has to
    // be read from her own id: her form stays frozen, and a re-edit here would
    // otherwise race the request already carrying her name.
    fireEvent.click(getButtonByText(ALICE.displayName));
    await waitFor(() => {
      expect(currentLocation().pathname).toBe(
        `/assistant/contacts/${ALICE.id}`,
      );
    });
    expect(getButton("Saving…")).toBeDefined();
    expect(getInputByPlaceholder("Give this human a name").disabled).toBe(true);

    await releaseUpsert(ALICE.id);

    expect(getButton("Save")).toBeDefined();
    expect(getInputByPlaceholder("Give this human a name").disabled).toBe(
      false,
    );

    // Bob's request outlives Alice's and is still his alone.
    fireEvent.click(getButtonByText(BOB.displayName));
    await waitFor(() => {
      expect(currentLocation().pathname).toBe(`/assistant/contacts/${BOB.id}`);
    });
    expect(getButton("Saving…")).toBeDefined();

    await releaseUpsert(BOB.id);
  });

  test("a permissions save in flight leaves another contact's picker enabled", async () => {
    holdUpsert = true;
    contactsFixture = [GUARDIAN, ALICE, BOB, PEER];
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText(ALICE.displayName));
    fireEvent.change(await waitFor(getPermissionsSelect), {
      target: { value: "fullAccess" },
    });
    await waitFor(() => {
      expect(getPermissionsSelect().disabled).toBe(true);
    });

    fireEvent.click(getButtonByText(BOB.displayName));
    await waitFor(() => {
      expect(currentLocation().pathname).toBe(`/assistant/contacts/${BOB.id}`);
    });

    expect(getPermissionsSelect().disabled).toBe(false);

    await releaseUpsert(ALICE.id);
  });

  test("a superseded delete returns to the list when its own contact is open", async () => {
    holdDelete = true;
    const { router } = renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText(ALICE.displayName));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    fireEvent.click(getButton("Delete Contact"));
    fireEvent.click(await waitFor(() => getModalButton("Delete")));
    await waitFor(() => getButton("Deleting…"));

    fireEvent.click(getButtonByText(PEER.displayName));
    await waitFor(() => {
      expect(currentLocation().pathname).toBe(`/assistant/contacts/${PEER.id}`);
    });
    fireEvent.click(getButton("Delete Contact"));
    fireEvent.click(await waitFor(() => getModalButton("Delete")));
    await waitFor(() => getButton("Deleting…"));

    // Alice's delete stopped receiving fresh options the moment Peer's
    // started, so its own closure still names Peer as the open contact.
    await act(async () => {
      await router.navigate(routes.contacts.detail(ALICE.id));
    });
    await waitFor(() => getInputByPlaceholder("Give this human a name"));

    await releaseDelete(ALICE.id);

    await waitFor(() => getInputByPlaceholder("Your name"));
    expect(currentLocation().pathname).toBe(routes.contacts.root);

    await releaseDelete(PEER.id);
  });
});

/**
 * A mutation's callbacks run from the request rather than from the page, so
 * they still fire once the page is gone. Their cache writes belong to the
 * data, but a navigation belongs to the page that asked for it: after the
 * user has left Contacts (or switched assistants) it would drag them back,
 * onto an id the assistant they are now on may not have.
 */
describe("ContactsPage mutations that land after the page is left", () => {
  test("a create that lands after the page is left stays off Contacts", async () => {
    isMobile = true;
    hasRoomForList = false;
    holdUpsert = true;
    const { router } = renderContactsPage();

    await startAddFromTopBar();
    await leaveContacts(router);

    await releaseUpsert(DRAFT.id);

    expect(currentLocation().pathname).toBe(AWAY_PATH);
  });

  test("a delete that lands after the page is left stays off Contacts", async () => {
    holdDelete = true;
    const { router } = renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText(ALICE.displayName));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    fireEvent.click(getButton("Delete Contact"));
    fireEvent.click(await waitFor(() => getModalButton("Delete")));
    await waitFor(() => getButton("Deleting…"));

    // The deleted contact is the one open, so on the page this would return
    // to the list.
    await leaveContacts(router);

    await releaseDelete(ALICE.id);

    expect(currentLocation().pathname).toBe(AWAY_PATH);
  });

  test("a create that lands while the page is open still opens the contact", async () => {
    isMobile = true;
    hasRoomForList = false;
    holdUpsert = true;
    renderContactsPage();

    await startAddFromTopBar();

    await releaseUpsert(DRAFT.id);

    await waitFor(() => {
      expect(currentLocation().pathname).toBe(routes.contacts.detail(DRAFT.id));
    });
  });
});

describe("ContactsPage URL-owned selection", () => {
  test("the bare route rests on the guardian and leaves the URL alone", async () => {
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));
    expect(currentLocation().pathname).toBe("/assistant/contacts");
  });

  test("a contact detail path opens that contact on first load", async () => {
    renderContactsPage({ initialPath: `/assistant/contacts/${ALICE.id}` });

    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    expect(currentLocation().pathname).toBe(`/assistant/contacts/${ALICE.id}`);
  });

  test("clicking a row moves the location to that contact's detail path", async () => {
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText("Alice"));

    await waitFor(() => {
      expect(currentLocation().pathname).toBe(
        `/assistant/contacts/${ALICE.id}`,
      );
    });
    await waitFor(() => getInputByPlaceholder("Give this human a name"));
  });

  test("an id no contact carries keeps its URL and says so", async () => {
    renderContactsPage({ initialPath: "/assistant/contacts/c-missing" });

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "This contact isn’t available.",
      );
    });
    expect(document.body.textContent).not.toContain("Select a contact");
    expect(currentLocation().pathname).toBe("/assistant/contacts/c-missing");
    expect(document.querySelector('[aria-current="page"]')).toBe(null);
  });

  test("a fresh cache that lacks the contact holds the link until it arrives", async () => {
    // The seeded list predates Alice and is inside its stale window, so the
    // mount serves it whole without a refetch: settled, successful, and short
    // one contact.
    const queryClient = makeQueryClient([GUARDIAN], { staleTime: 10_000 });

    renderContactsPage({
      initialPath: `/assistant/contacts/${ALICE.id}`,
      queryClient,
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "This contact isn’t available.",
      );
    });
    expect(currentLocation().pathname).toBe(`/assistant/contacts/${ALICE.id}`);

    // Alice reaches the cache the way an invalidation or an SSE-driven refetch
    // delivers her, and the held link resolves with no navigation.
    queryClient.setQueryData(CONTACTS_KEY, { contacts: [GUARDIAN, ALICE] });

    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    expect(currentLocation().pathname).toBe(`/assistant/contacts/${ALICE.id}`);
  });

  /**
   * A list that has not settled cannot prove a contact is absent, so the pane
   * spins on the deep link rather than claiming either state. TanStack's
   * default `networkMode` pauses a request made offline instead of running or
   * failing it, which is why the offline shapes are neither fetching nor
   * errored while they hold nothing the link resolves against.
   */
  test.each([
    {
      shape: "a revalidating cache",
      prepare: () => {},
      queryClient: () => makeQueryClient([GUARDIAN]),
      // Cached rows render synchronously while the refetch runs, so the held
      // state is the first frame and awaiting anything would pass it.
      reachHeldState: async () => {},
    },
    {
      shape: "a failed fetch",
      prepare: () => {
        contactsShouldReject = true;
      },
      queryClient: () => undefined,
      reachHeldState: async () => {
        // The list's own empty state means the query has finished.
        await waitFor(() => getButtonByText("Add Contact"));
      },
    },
    {
      shape: "an offline mount with no cache",
      prepare: () => {
        onlineManager.setOnline(false);
      },
      queryClient: () => undefined,
      reachHeldState: async () => {
        await waitFor(() => getButtonByText("Add Contact"));
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    },
    {
      shape: "an offline mount with a cache that lacks the contact",
      prepare: () => {
        onlineManager.setOnline(false);
      },
      queryClient: () => makeQueryClient([GUARDIAN]),
      reachHeldState: async () => {
        await waitFor(() => getButtonByText("Example User"));
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    },
  ])(
    "$shape holds the deep link and spins on it",
    async ({ prepare, queryClient, reachHeldState }) => {
      prepare();

      renderContactsPage({
        initialPath: `/assistant/contacts/${ALICE.id}`,
        queryClient: queryClient(),
      });

      await reachHeldState();

      expect(currentLocation().pathname).toBe(
        `/assistant/contacts/${ALICE.id}`,
      );
      expect(queryPaneSpinner()).not.toBe(null);
      expect(document.body.textContent).not.toContain("Select a contact");
      expect(document.body.textContent).not.toContain(
        "This contact isn’t available.",
      );
    },
  );

  test("a deep link the cached list lacks resolves once the fetch lands", async () => {
    // Cached contacts predate Alice (added elsewhere), so the mount serves
    // them while refetching. The fresh list carries her, so the link holds.
    renderContactsPage({
      initialPath: `/assistant/contacts/${ALICE.id}`,
      queryClient: makeQueryClient([GUARDIAN]),
    });

    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    expect(currentLocation().pathname).toBe(`/assistant/contacts/${ALICE.id}`);
  });

  test("an encoded id in the URL opens the contact it names", async () => {
    const slashed = { ...ALICE, id: "org/team c-1" } as ContactPayload;
    contactsFixture = [GUARDIAN, slashed];

    renderContactsPage({ initialPath: routes.contacts.detail(slashed.id) });

    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    expect(document.body.textContent).not.toContain(
      "This contact isn’t available.",
    );
  });
});

describe("ContactsPage contact permissions", () => {
  test("hides Permissions on the guardian and a peer assistant", async () => {
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));
    expect(document.querySelector('[data-testid="contact-permissions"]')).toBe(
      null,
    );

    fireEvent.click(getButtonByText("Peer Assistant"));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    expect(document.querySelector('[data-testid="contact-permissions"]')).toBe(
      null,
    );
  });

  test("lets a regular human contact set a risk ceiling", async () => {
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText("Alice"));

    const select = await waitFor(getPermissionsSelect);
    expect(document.body.textContent).toContain("Permissions");
    expect(select.value).toBe("");

    fireEvent.change(select, { target: { value: "fullAccess" } });
    await waitFor(() => {
      expect(lastUpsertBody).toEqual({
        id: "c-alice",
        displayName: "Alice",
        autoApproveThreshold: "high",
      });
    });
  });

  test("a failed permissions save surfaces a toast and does not reject", async () => {
    upsertShouldReject = true;

    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText("Alice"));
    const select = await waitFor(getPermissionsSelect);
    fireEvent.change(select, { target: { value: "fullAccess" } });

    await waitFor(() => {
      expect(toastErrorCalls).toEqual(["Not found"]);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandledRejections).toEqual([]);
  });
});

describe("ContactsPage as a phone screen", () => {
  beforeEach(() => {
    isMobile = true;
    hasRoomForList = false;
  });

  test("the bare route is the list, with no detail and no drawer", async () => {
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Search Contacts"));
    expect(getButtonByText("Alice")).toBeDefined();
    expect(queryInputByPlaceholder("Your name")).toBe(null);
    expect(queryDrawerTrigger()).toBe(null);
  });

  test("tapping a row pushes the contact and takes the list off screen", async () => {
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Search Contacts"));
    fireEvent.click(getButtonByText("Alice"));

    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    expect(currentLocation().pathname).toBe(`/assistant/contacts/${ALICE.id}`);
    expect(currentLocation().state).toEqual({ pushedFromList: true });
    expect(queryInputByPlaceholder("Search Contacts")).toBe(null);
  });

  test("the top bar carries the add action only while the list is the page", async () => {
    const { unmount } = renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Search Contacts"));
    expect(headerTrailing()).not.toBe(null);

    fireEvent.click(getButtonByText("Alice"));
    await waitFor(() => {
      expect(headerTrailing()).toBe(null);
    });

    unmount();
    expect(headerTrailing()).toBe(null);
  });

  test("the pushed-screen flag follows the open contact and clears on unmount", async () => {
    const { router, unmount } = renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Search Contacts"));
    expect(detailIsScreen()).toBe(false);

    // The layout publishes its Back from this flag, so it has to be reported
    // no later than the navigation it describes: arriving a commit after the
    // route leaves a Back aimed at the assistant overview over an open
    // contact, and a tap in that window leaves Contacts.
    const pathWhenSet: string[] = [];
    const unsubscribe = useIntelligenceLayoutSlotsStore.subscribe(
      (state, previous) => {
        if (state.detailIsScreen && !previous.detailIsScreen) {
          pathWhenSet.push(router.state.location.pathname);
        }
      },
    );
    fireEvent.click(getButtonByText("Alice"));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    unsubscribe();

    // The first raise is the one that matters. The effect's cleanup lowers
    // and re-raises the flag inside the commit that opens the detail, and
    // nothing renders in between.
    expect(pathWhenSet[0]).toBe(routes.contacts.root);
    expect(detailIsScreen()).toBe(true);

    await act(async () => {
      await router.navigate(-1);
    });
    await waitFor(() => getInputByPlaceholder("Search Contacts"));
    expect(detailIsScreen()).toBe(false);

    unmount();
    expect(detailIsScreen()).toBe(false);
  });

  test("the list screen spins through its first load instead of going blank", async () => {
    // As the page the list draws nothing while it has no contacts: no search
    // field, no guardian row, and the add action is suppressed. A top bar
    // over an empty page is what the spinner replaces.
    renderContactsPage();

    expect(queryPaneSpinner()).not.toBe(null);
    expect(queryInputByPlaceholder("Search Contacts")).toBe(null);

    await waitFor(() => getInputByPlaceholder("Search Contacts"));
    expect(queryPaneSpinner()).toBe(null);
  });

  test("the top bar add creates a contact and opens it", async () => {
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Search Contacts"));
    const addAction = headerTrailing();
    expect(addAction).not.toBe(null);

    await act(async () => {
      addAction!.props.onClick();
    });

    await waitFor(() => {
      expect(currentLocation().pathname).toBe(
        `/assistant/contacts/${DRAFT.id}`,
      );
    });
    expect(lastUpsertBody).toEqual({ displayName: DRAFT_CONTACT_NAME });
  });

  test("deleting a contact pushed from the list returns to the list", async () => {
    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Search Contacts"));
    fireEvent.click(getButtonByText("Alice"));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));

    fireEvent.click(getButton("Delete Contact"));
    fireEvent.click(await waitFor(() => getModalButton("Delete")));

    await waitFor(() => getInputByPlaceholder("Search Contacts"));
    expect(currentLocation().pathname).toBe("/assistant/contacts");
  });

  test("a merge on a deep-linked contact leaves the entry alone", async () => {
    const { router } = renderContactsPage({
      initialPath: `/assistant/contacts/${ALICE.id}`,
    });

    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    const entryBefore = router.state.location.key;

    await mergePeerIntoOpenContact();

    // The survivor is the contact already open, so the merge navigates
    // nowhere: the entry keeps its key and never gains a marker claiming a
    // list sits behind it.
    expect(currentLocation().pathname).toBe(`/assistant/contacts/${ALICE.id}`);
    expect(currentLocation().state).toBe(null);
    expect(router.state.location.key).toBe(entryBefore);
  });

  test("a merge on a contact pushed from the list keeps one Back to the list", async () => {
    const { router } = renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Search Contacts"));
    fireEvent.click(getButtonByText(ALICE.displayName));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    expect(currentLocation().state).toEqual({ pushedFromList: true });

    await mergePeerIntoOpenContact();

    expect(currentLocation().pathname).toBe(`/assistant/contacts/${ALICE.id}`);
    expect(currentLocation().state).toEqual({ pushedFromList: true });

    await act(async () => {
      await router.navigate(-1);
    });

    await waitFor(() => getInputByPlaceholder("Search Contacts"));
    expect(currentLocation().pathname).toBe("/assistant/contacts");
  });
});

describe("ContactsPage back swipe ownership", () => {
  test("a contact filling the phone owns the swipe and it returns to the list", async () => {
    isMobile = true;
    hasRoomForList = false;

    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Search Contacts"));
    fireEvent.click(getButtonByText(ALICE.displayName));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));

    expect(lastSwipeArgs).not.toBe(null);
    expect(lastSwipeArgs!.enabled).toBe(true);
    expect(lastSwipeArgs!.navKey).toBe(`/assistant/contacts/${ALICE.id}`);

    await act(async () => {
      lastSwipeArgs!.onBack();
    });

    await waitFor(() => getInputByPlaceholder("Search Contacts"));
    expect(currentLocation().pathname).toBe("/assistant/contacts");
  });

  test("the phone list screen leaves the edge to the nav drawer", async () => {
    isMobile = true;
    hasRoomForList = false;

    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Search Contacts"));
    expect(lastSwipeArgs).not.toBe(null);
    expect(lastSwipeArgs!.enabled).toBe(false);
  });
});

describe("ContactsPage in a narrow desktop pane", () => {
  test("keeps the drawer, the guardian detail, and an empty top bar", async () => {
    hasRoomForList = false;

    renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Your name"));
    expect(queryDrawerTrigger()).not.toBe(null);
    expect(headerTrailing()).toBe(null);
  });
});

/**
 * The layout's Back and the edge swipe both follow the pane, not the window:
 * a mobile-width window whose pane still seats the list beside the detail
 * shows both, so a Back to the list would point at a list already on screen
 * and a back swipe would leave the page the user can see.
 */
describe.each([
  { mode: "a desktop window", mobile: false, roomForList: true },
  { mode: "a narrow desktop pane", mobile: false, roomForList: false },
  {
    mode: "a mobile window with room for the list",
    mobile: true,
    roomForList: true,
  },
])("ContactsPage on $mode", ({ mobile, roomForList }) => {
  test("reports no pushed detail screen and leaves the edge alone", async () => {
    isMobile = mobile;
    hasRoomForList = roomForList;

    renderContactsPage({ initialPath: `/assistant/contacts/${ALICE.id}` });

    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    expect(detailIsScreen()).toBe(false);
    expect(lastSwipeArgs).not.toBe(null);
    expect(lastSwipeArgs!.enabled).toBe(false);
  });
});

describe("ContactsPage under the production route shape", () => {
  // A remount between the two sibling entries would drop every piece of page
  // state, starting with the search text.
  test("the search text survives opening a contact and coming back", async () => {
    isMobile = true;
    hasRoomForList = false;

    const { router } = renderContactsPage();

    await waitFor(() => getInputByPlaceholder("Search Contacts"));
    fireEvent.change(getInputByPlaceholder("Search Contacts"), {
      target: { value: "Ali" },
    });
    expect(getInputByPlaceholder("Search Contacts").value).toBe("Ali");

    fireEvent.click(getButtonByText("Alice"));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    expect(currentLocation().pathname).toBe(`/assistant/contacts/${ALICE.id}`);

    await act(async () => {
      await router.navigate(-1);
    });

    await waitFor(() => {
      expect(getInputByPlaceholder("Search Contacts").value).toBe("Ali");
    });
  });
});

describe("ContactsPage plugin verify", () => {
  test("opens the manual verify modal instead of starting the iMessage setup chat", async () => {
    availableChannelsOverride = [
      {
        id: "imessage",
        source: "plugin:imessage",
        label: "iMessage",
        subtitle: "Provided by the iMessage plugin",
        icon: "message-square",
        supportsVerification: false,
        setupMessages: {
          guardian: "I want to set up iMessage. Can you help me?",
          contact:
            "I'd like to reach you on iMessage. Can you help me get set up?",
        },
      },
    ];
    const onStartSetupConversation = mock(() => {});

    renderContactsPage({ onStartSetupConversation });

    const verify = await waitFor(() => getButton("Verify"));
    fireEvent.click(verify);

    expect(onStartSetupConversation).not.toHaveBeenCalled();
    const addressInput = await waitFor(() =>
      getInputByPlaceholder("+15551234567"),
    );
    fireEvent.change(addressInput, { target: { value: "+15551234567" } });

    fireEvent.click(getModalButton("Verify"));

    await waitFor(() => {
      expect(linkAndVerifyCalls).toEqual([
        { type: "imessage", address: "+15551234567" },
      ]);
    });
    expect(onStartSetupConversation).not.toHaveBeenCalled();
  });
});
