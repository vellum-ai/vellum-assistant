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

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { ApiError } from "@/utils/api-errors";
import type { ChannelInfo, ContactPayload } from "@/domains/contacts/types";
import * as rqGen from "@/generated/daemon/@tanstack/react-query.gen";
import * as sdkGen from "@/generated/daemon/sdk.gen";

// ---------------------------------------------------------------------------
// Module-level holders
// ---------------------------------------------------------------------------

let toastErrorCalls: string[] = [];
let upsertShouldReject = false;
let lastUpsertBody: unknown = null;
let contactsFixture: ContactPayload[] = [];
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

// Resolve every query the page renders synchronously to a fixture so the
// guardian auto-selects and no real network is attempted. Real mutation
// hooks (merge / channel-patch) are kept — they aren't fired here.
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...rqGen,
  contactsGetOptions: () => ({
    queryKey: CONTACTS_KEY,
    queryFn: async () => ({ contacts: contactsFixture }),
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

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return createElement(
    MemoryRouter,
    null,
    createElement(QueryClientProvider, { client }, children),
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
  availableChannelsOverride = null;
  linkAndVerifyCalls.length = 0;
  unhandledRejections.length = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  cleanup();
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

    // The guardian auto-selects, rendering its editable Name field.
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

describe("ContactsPage contact permissions", () => {
  test("hides Permissions on the guardian, the assistant, and a peer assistant", async () => {
    render(
      <Wrapper>
        <ContactsPage assistantId="asst-1" />
      </Wrapper>,
    );

    await waitFor(() => getInputByPlaceholder("Your name"));
    expect(document.querySelector('[data-testid="contact-permissions"]')).toBe(
      null,
    );

    fireEvent.click(getButtonByText("your assistant"));
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Where your assistant can be reached.",
      );
    });
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
          contact: "I'd like to reach you on iMessage. Can you help me get set up?",
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

    const dialog = document.querySelector('[data-slot="modal-content"]');
    if (!dialog) {
      throw new Error("expected the verify modal");
    }
    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Verify",
    );
    if (!confirm) {
      throw new Error("expected a Verify button in the modal");
    }
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(linkAndVerifyCalls).toEqual([
        { type: "imessage", address: "+15551234567" },
      ]);
    });
    expect(onStartSetupConversation).not.toHaveBeenCalled();
  });
});
