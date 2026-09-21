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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, Fragment, type ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { ApiError } from "@/utils/api-errors";
import type { ChannelInfo, ContactPayload } from "@/domains/contacts/types";
import {
  currentLocation,
  LocationProbe,
} from "@/hooks/router-probe.test-helper";
import * as rqGen from "@/generated/daemon/@tanstack/react-query.gen";
import * as sdkGen from "@/generated/daemon/sdk.gen";

// ---------------------------------------------------------------------------
// Module-level holders
// ---------------------------------------------------------------------------

let toastErrorCalls: string[] = [];
let upsertShouldReject = false;
let lastUpsertBody: unknown = null;
let contactsFixture: ContactPayload[] = [];
let contactsShouldReject = false;
let availableChannelsOverride: ChannelInfo[] | null = null;
const linkAndVerifyCalls: Array<{ type: string; address: string }> = [];
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

mock.module("@/hooks/use-assistant-channels", () => ({
  useAssistantChannels: () => ({
    channels: [],
    pendingChannelKey: null,
    onSetup: () => {},
    onDisconnect: () => {},
  }),
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
    if (body.id === ALICE.id) {
      return { ...ALICE, ...body };
    }
    if (body.id === PEER.id) {
      return { ...PEER, ...body };
    }
    return { ...GUARDIAN, ...body };
  },
  deleteContact: async () => {},
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
// and channel-patch) are kept; they aren't fired here.
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

/**
 * `useParams` only yields `contactId` under a matching route pattern, so the
 * page is mounted under the real `contacts/:contactId?` pattern.
 */
function Wrapper({
  children,
  initialPath = "/assistant/contacts",
  queryClient,
}: {
  children: ReactNode;
  initialPath?: string;
  queryClient?: QueryClient;
}) {
  const client = queryClient ?? makeQueryClient();
  return createElement(
    MemoryRouter,
    { initialEntries: [initialPath] },
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: "/assistant/contacts/:contactId?",
          element: createElement(
            Fragment,
            null,
            children,
            createElement(LocationProbe),
          ),
        }),
      ),
    ),
  );
}

function getInputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = Array.from(
    document.querySelectorAll<HTMLInputElement>("input"),
  ).find((el) => el.placeholder === placeholder);
  if (!input) {
    throw new Error(`expected an input with placeholder "${placeholder}"`);
  }
  return input;
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
  linkAndVerifyCalls.length = 0;
  unhandledRejections.length = 0;
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
          {
            client: new QueryClient({
              defaultOptions: { queries: { retry: false } },
            }),
          },
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

    render(
      <Wrapper>
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

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
    render(
      <Wrapper>
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

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
    render(
      <Wrapper>
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

    // The detail pane stays blank while contacts load: "Select a contact" is
    // the wrong copy before the guardian is known.
    expect(document.body.textContent).not.toContain("Select a contact");

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText("Alice"));
    await waitFor(() => getInputByPlaceholder("Give this human a name"));

    fireEvent.click(getButton("Delete Contact"));
    fireEvent.click(await waitFor(() => getModalButton("Delete")));

    await waitFor(() => getInputByPlaceholder("Your name"));
    expect(currentLocation().pathname).toBe("/assistant/contacts");
  });
});

describe("ContactsPage URL-owned selection", () => {
  test("the bare route rests on the guardian and leaves the URL alone", async () => {
    render(
      <Wrapper>
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

    await waitFor(() => getInputByPlaceholder("Your name"));
    expect(currentLocation().pathname).toBe("/assistant/contacts");
  });

  test("a contact detail path opens that contact on first load", async () => {
    render(
      <Wrapper initialPath={`/assistant/contacts/${ALICE.id}`}>
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    expect(currentLocation().pathname).toBe(`/assistant/contacts/${ALICE.id}`);
  });

  test("clicking a row moves the location to that contact's detail path", async () => {
    render(
      <Wrapper>
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText("Alice"));

    await waitFor(() => {
      expect(currentLocation().pathname).toBe(
        `/assistant/contacts/${ALICE.id}`,
      );
    });
    await waitFor(() => getInputByPlaceholder("Give this human a name"));
  });

  test("an id no contact carries keeps its URL and shows the empty state", async () => {
    render(
      <Wrapper initialPath="/assistant/contacts/c-missing">
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("Select a contact");
    });
    expect(currentLocation().pathname).toBe("/assistant/contacts/c-missing");
    expect(document.querySelector('[aria-current="page"]')).toBe(null);
  });

  test("a fresh cache that lacks the contact holds the link until it arrives", async () => {
    // The seeded list predates Alice and is inside its stale window, so the
    // mount serves it whole without a refetch: settled, successful, and short
    // one contact.
    const queryClient = makeQueryClient([GUARDIAN], { staleTime: 10_000 });

    render(
      <Wrapper
        initialPath={`/assistant/contacts/${ALICE.id}`}
        queryClient={queryClient}
      >
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("Select a contact");
    });
    expect(currentLocation().pathname).toBe(`/assistant/contacts/${ALICE.id}`);

    // Alice reaches the cache the way an invalidation or an SSE-driven refetch
    // delivers her, and the held link resolves with no navigation.
    queryClient.setQueryData(CONTACTS_KEY, { contacts: [GUARDIAN, ALICE] });

    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    expect(currentLocation().pathname).toBe(`/assistant/contacts/${ALICE.id}`);
  });

  test("a deep link the cached list lacks survives the revalidating fetch", async () => {
    // Cached contacts predate Alice (added elsewhere), so the mount serves
    // them while refetching. The fresh list carries her, so the link holds.
    render(
      <Wrapper
        initialPath={`/assistant/contacts/${ALICE.id}`}
        queryClient={makeQueryClient([GUARDIAN])}
      >
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

    // The fetch is still in flight, so the pane withholds the empty state
    // rather than claiming the id is unknown.
    expect(currentLocation().pathname).toBe(`/assistant/contacts/${ALICE.id}`);
    expect(document.body.textContent).not.toContain("Select a contact");

    await waitFor(() => getInputByPlaceholder("Give this human a name"));
    expect(currentLocation().pathname).toBe(`/assistant/contacts/${ALICE.id}`);
  });

  test("a failed contacts fetch keeps the deep link intact", async () => {
    contactsShouldReject = true;

    render(
      <Wrapper initialPath={`/assistant/contacts/${ALICE.id}`}>
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

    // The list's own empty state means the query has finished. A failure is
    // not a settled list, so the pane withholds the empty state.
    await waitFor(() => getButtonByText("Add Contact"));
    expect(currentLocation().pathname).toBe(`/assistant/contacts/${ALICE.id}`);
    expect(document.body.textContent).not.toContain("Select a contact");
  });

  // TanStack's default `networkMode` pauses a request made offline instead of
  // running or failing it, so the list is neither fetching nor errored while
  // it holds nothing the link can resolve against.
  test("an offline mount with no cache holds the deep link", async () => {
    onlineManager.setOnline(false);

    render(
      <Wrapper initialPath={`/assistant/contacts/${ALICE.id}`}>
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

    await waitFor(() => getButtonByText("Add Contact"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(currentLocation().pathname).toBe(`/assistant/contacts/${ALICE.id}`);
    expect(document.body.textContent).not.toContain("Select a contact");
  });

  test("an offline mount holds a deep link the cached list lacks", async () => {
    onlineManager.setOnline(false);

    render(
      <Wrapper
        initialPath={`/assistant/contacts/${ALICE.id}`}
        queryClient={makeQueryClient([GUARDIAN])}
      >
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

    // The cache renders straight away while its revalidation stays paused.
    await waitFor(() => getButtonByText("Example User"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(currentLocation().pathname).toBe(`/assistant/contacts/${ALICE.id}`);
    expect(document.body.textContent).not.toContain("Select a contact");
  });
});

describe("ContactsPage contact permissions", () => {
  test("hides Permissions on the guardian and a peer assistant", async () => {
    render(
      <Wrapper>
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

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
    render(
      <Wrapper>
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText("Alice"));

    const select = await waitFor(() => {
      const node = document.querySelector(
        '[data-testid="contact-permissions-select"]',
      );
      if (!(node instanceof HTMLSelectElement)) {
        throw new Error("expected the permissions picker");
      }
      return node;
    });
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

    render(
      <Wrapper>
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

    await waitFor(() => getInputByPlaceholder("Your name"));
    fireEvent.click(getButtonByText("Alice"));
    const select = await waitFor(() => {
      const node = document.querySelector(
        '[data-testid="contact-permissions-select"]',
      );
      if (!(node instanceof HTMLSelectElement)) {
        throw new Error("expected the permissions picker");
      }
      return node;
    });
    fireEvent.change(select, { target: { value: "fullAccess" } });

    await waitFor(() => {
      expect(toastErrorCalls).toEqual(["Not found"]);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandledRejections).toEqual([]);
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

    render(
      <Wrapper>
        <ContactsPage
          assistantId="asst-1"
          onStartSetupConversation={onStartSetupConversation}
        />
      </Wrapper>,
    );

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
