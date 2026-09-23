/**
 * The inbox route as the wizard lands on it after an upgrade: entitled, with
 * no address and no domain, it is the setup card with the handle open; once
 * Get started registers the address, it is the mailbox. The platform is
 * mocked at the generated SDK, the hooks that reach the session and the
 * daemon at their module boundaries.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

import * as activeAssistantIdModule from "@/assistant/use-active-assistant-id";
import * as apiSdk from "@/generated/api/sdk.gen";
import type {
  AssistantDomain,
  AssistantEmailAddress,
} from "@/generated/api/types.gen";
import * as daemonSdk from "@/generated/daemon/sdk.gen";
import * as assistantAvatarMod from "@/hooks/use-assistant-avatar";
import * as platformGate from "@/hooks/use-platform-gate";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

const ASSISTANT_ID = "assistant-1";
const PLATFORM_ASSISTANT_ID = "platform-1";

mock.module("@/assistant/use-active-assistant-id", () => ({
  ...activeAssistantIdModule,
  useActiveAssistantId: () => ASSISTANT_ID,
}));

mock.module("@/hooks/use-platform-gate", () => ({
  ...platformGate,
  usePlatformGate: () => "full",
  usePlatformGateWithPending: () => "full",
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
}));

mock.module("@/hooks/use-platform-assistant-id", () => ({
  usePlatformAssistantId: () => ({
    platformAssistantId: PLATFORM_ASSISTANT_ID,
    isLoading: false,
    error: null,
  }),
}));

mock.module("@/hooks/use-assistant-avatar", () => ({
  ...assistantAvatarMod,
  useAssistantAvatar: () => ({
    components: null,
    traits: null,
    customImageUrl: null,
    isLoading: false,
    invalidate: () => {},
  }),
}));

// The design library's index re-exports every name from this module, so the
// stand-in has to carry them all or the import graph fails to link.
const toastSuccessCalls: string[] = [];
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: (message: string) => {
      toastSuccessCalls.push(message);
    },
    error: () => {},
    info: () => {},
  },
  Toaster: () => null,
  ToastContent: () => null,
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

/** The address list, empty until setup registers one. */
let addresses: AssistantEmailAddress[] = [];
/** The domain list, empty on a fresh upgrade. */
let domains: AssistantDomain[] = [];
const domainCreateBodies: unknown[] = [];
/** When set, the domain is claimed but the address on it is not made. */
let domainEmailError: { detail: string; code: string } | null = null;

function page<T>(results: T[]) {
  return {
    data: { count: results.length, next: null, previous: null, results },
    response: { ok: true },
  };
}

mock.module("@/generated/api/sdk.gen", () => ({
  ...apiSdk,
  organizationsBillingSubscriptionRetrieve: () =>
    Promise.resolve({
      data: {
        plan_id: "pro",
        status: "active",
        entitlements: { managed_email: true, phone_number: false },
      },
      response: { ok: true },
    }),
  assistantsList: () =>
    Promise.resolve(
      page([
        {
          id: PLATFORM_ASSISTANT_ID,
          name: "Ziggy",
          handle: "bright-vole-02a64h",
        },
      ]),
    ),
  assistantsEmailAddressesList: () => Promise.resolve(page(addresses)),
  assistantsDomainsList: () => Promise.resolve(page(domains)),
  assistantsDomainsCreate: (options: { body: unknown }) => {
    domainCreateBodies.push(options.body);
    // One call registers the subdomain and, as a best effort, the address
    // on it; a failed address comes back as a field on the success.
    domains = [
      {
        id: "domain-1",
        subdomain: "bright-vole-02a64h",
        created: "2026-09-22T00:00:00Z",
        modified: "2026-09-22T00:00:00Z",
      },
    ];
    if (domainEmailError) {
      return Promise.resolve({
        data: { ...domains[0], email_error: domainEmailError },
        response: { ok: true },
      });
    }
    addresses = [
      {
        id: "address-1",
        address: "hi@bright-vole-02a64h.vellum.me",
        created_at: "2026-09-22T00:00:00Z",
      },
    ];
    return Promise.resolve({ data: domains[0], response: { ok: true } });
  },
  assistantsEmailsList: () => Promise.resolve(page([])),
  assistantsEmailAddressesStatusRetrieve: () =>
    Promise.resolve({
      data: {
        address: "hi@bright-vole-02a64h.vellum.me",
        status: "active",
        usage: {
          sent_today: 0,
          daily_limit: 100,
          received_today: 0,
          sent_this_month: 0,
          received_this_month: 0,
        },
        created_at: "2026-09-22T00:00:00Z",
      },
      response: { ok: true },
    }),
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  channelsReadinessRefreshPost: () =>
    Promise.resolve({ data: {}, response: { ok: true } }),
}));

const { AssistantInboxPageRoute } =
  await import("./assistant-inbox-page-route");

function renderRoute() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/assistant/inbox"]}>
        <AssistantInboxPageRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  addresses = [];
  domains = [];
  domainCreateBodies.length = 0;
  domainEmailError = null;
  toastSuccessCalls.length = 0;
  useClientFeatureFlagStore.setState({ assistantInbox: true, hydrated: true });
  useAssistantIdentityStore.setState({ name: "Ziggy" });
});

afterEach(() => {
  cleanup();
  useClientFeatureFlagStore.setState({
    assistantInbox: false,
    hydrated: false,
  });
});

describe("AssistantInboxPageRoute after an upgrade", () => {
  test("with no address and no domain, offers setup with the handle open, then shows the inbox once the address exists", async () => {
    renderRoute();

    // The setup card, with the handle as a field the user can still choose.
    const handle = (await screen.findByLabelText(
      "Handle (public)",
    )) as HTMLInputElement;
    expect(handle.value).toBe("bright-vole-02a64h");
    expect(handle.readOnly).toBe(false);
    expect(
      screen.getByText(
        "The handle becomes your assistant's public handle. You won't be able to change it once set.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Ziggy's Inbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    // One registration, the handle as the subdomain and the prefix on it.
    await waitFor(() => expect(domainCreateBodies.length).toBe(1));
    expect(domainCreateBodies[0]).toEqual({
      subdomain: "bright-vole-02a64h",
      email_username: "hi",
    });

    // The address now exists, so the route is the mailbox.
    await waitFor(() => expect(screen.getByText("Ziggy's Inbox")).toBeTruthy());
    expect(screen.queryByLabelText("Handle (public)")).toBeNull();
    // The root domain comes from the environment store, so only the
    // address's own parts are pinned.
    expect(toastSuccessCalls.length).toBe(1);
    expect(toastSuccessCalls[0]).toMatch(
      /^hi@bright-vole-02a64h\..+ is ready\.$/,
    );
  });

  test("a claimed subdomain whose address could not be made is an error, not a ready address", async () => {
    domainEmailError = {
      detail:
        'Failed to provision email domain: {"statusCode":403,"message":"You have reached the domain limit of your plan. Upgrade to add more.","name":"validation_error"}',
      code: "resend_domain_error",
    };
    renderRoute();

    await screen.findByLabelText("Handle (public)");
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    await waitFor(() => expect(domainCreateBodies.length).toBe(1));
    // The provider's sentence, under the fields, and no claim of readiness.
    await waitFor(() =>
      expect(
        screen.getByText(
          "Failed to provision email domain: You have reached the domain limit of your plan. Upgrade to add more.",
        ),
      ).toBeTruthy(),
    );
    expect(toastSuccessCalls).toEqual([]);
    expect(screen.queryByText("Ziggy's Inbox")).toBeNull();
    // The subdomain is claimed now, so the handle is settled and only the
    // prefix is left to choose.
    await waitFor(() =>
      expect(screen.queryByLabelText("Handle (public)")).toBeNull(),
    );
  });

  test("with an address already registered, opens straight onto the inbox", async () => {
    domains = [
      {
        id: "domain-1",
        subdomain: "bright-vole-02a64h",
        created: "2026-09-22T00:00:00Z",
        modified: "2026-09-22T00:00:00Z",
      },
    ];
    addresses = [
      {
        id: "address-1",
        address: "hi@bright-vole-02a64h.vellum.me",
        created_at: "2026-09-22T00:00:00Z",
      },
    ];
    renderRoute();

    await waitFor(() => expect(screen.getByText("Ziggy's Inbox")).toBeTruthy());
    expect(screen.queryByText("Assistant Email")).toBeNull();
  });
});
