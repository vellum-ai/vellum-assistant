/**
 * Repair flow for an already-claimed managed domain whose provider status is
 * `not_started`. The address stays read-only; Complete domain setup calls the
 * bodyless provision mutation and resumes verification polling only after the
 * provider leaves `not_started`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import {
  assistantsDomainsListOptions,
  assistantsDomainsVerificationStatusRetrieveOptions,
  assistantsDomainsVerificationStatusRetrieveQueryKey,
  assistantsEmailAddressesListOptions,
  assistantsEmailAddressesStatusRetrieveOptions,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import * as sdkGen from "@/generated/api/sdk.gen";
import type {
  AssistantDomain,
  AssistantEmailAddress,
  DomainVerificationStatus,
  DomainVerificationStatusStatusEnum,
  SubscriptionResponse,
} from "@/generated/api/types.gen";

const ASSISTANT_ID = "assistant-123";
const DOMAIN_ID = "domain-123";
const ADDRESS_ID = "email-123";
const ADDRESS = "user@example.com";
const SUBDOMAIN = "my-assistant";
const ROOT_DOMAIN = "example.com";

const toastSuccessCalls: string[] = [];
const toastErrorCalls: string[] = [];
const captureErrorCalls: Array<{ err: unknown; context?: string }> = [];
const provisionCalls: unknown[] = [];
const emailCreateCalls: unknown[] = [];

let verificationStatus: DomainVerificationStatus;
let provisionImpl: (opts: unknown) => Promise<{
  data: DomainVerificationStatus;
  response: { ok: boolean };
}>;

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: (message: string) => {
      toastSuccessCalls.push(message);
    },
    error: (message: string) => {
      toastErrorCalls.push(message);
    },
  },
  Toaster: () => null,
  ToastContent: () => null,
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: (err: unknown, opts?: { context?: string }) => {
    captureErrorCalls.push({ err, context: opts?.context });
  },
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionRetrieve: () =>
    Promise.resolve({
      data: makeSubscription(),
      response: { ok: true },
    }),
  assistantsDomainsList: () =>
    Promise.resolve({
      data: { count: 1, next: null, previous: null, results: [makeDomain()] },
      response: { ok: true },
    }),
  assistantsEmailAddressesList: () =>
    Promise.resolve({
      data: { count: 1, next: null, previous: null, results: [makeAddress()] },
      response: { ok: true },
    }),
  assistantsDomainsVerificationStatusRetrieve: () =>
    Promise.resolve({
      data: verificationStatus,
      response: { ok: true },
    }),
  assistantsEmailAddressesStatusRetrieve: () =>
    Promise.resolve({
      data: {
        address: ADDRESS,
        status: "active",
        usage: {
          sent_today: 0,
          daily_limit: 100,
          received_today: 0,
          sent_this_month: 0,
          received_this_month: 0,
        },
        created_at: "2026-01-01T00:00:00Z",
      },
      response: { ok: true },
    }),
  assistantsEmailAddressesCreate: (opts: unknown) => {
    emailCreateCalls.push(opts);
    return Promise.resolve({ data: makeAddress(), response: { ok: true } });
  },
  assistantsDomainsProvisionCreate: (opts: unknown) => {
    provisionCalls.push(opts);
    return provisionImpl(opts);
  },
}));

const {
  EmailManagedContent,
  DOMAIN_VERIFICATION_POLL_MS,
  domainVerificationRefetchInterval,
} = await import("@/domains/channels/components/email-managed-content");

function makeSubscription(): SubscriptionResponse {
  return {
    plan_id: "pro",
    status: "active",
    renewal_date: null,
    current_period_start: null,
    current_period_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    entitlements: { managed_email: true, phone_number: false },
  };
}

function makeDomain(): AssistantDomain {
  return {
    id: DOMAIN_ID,
    subdomain: SUBDOMAIN,
    created: "2026-01-01T00:00:00Z",
    modified: "2026-01-01T00:00:00Z",
  };
}

function makeAddress(): AssistantEmailAddress {
  return {
    id: ADDRESS_ID,
    address: ADDRESS,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function makeVerification(
  status: DomainVerificationStatusStatusEnum,
): DomainVerificationStatus {
  return {
    domain: `${SUBDOMAIN}.${ROOT_DOMAIN}`,
    status,
    message:
      status === "not_started"
        ? "Domain has not been provisioned with the email provider yet."
        : status,
  };
}

function seedClient(
  client: QueryClient,
  status: DomainVerificationStatusStatusEnum,
): void {
  const path = { assistant_id: ASSISTANT_ID };
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveOptions().queryKey,
    makeSubscription(),
  );
  client.setQueryData(
    assistantsDomainsListOptions({ path }).queryKey,
    { count: 1, next: null, previous: null, results: [makeDomain()] },
  );
  client.setQueryData(
    assistantsEmailAddressesListOptions({ path }).queryKey,
    { count: 1, next: null, previous: null, results: [makeAddress()] },
  );
  client.setQueryData(
    assistantsDomainsVerificationStatusRetrieveOptions({
      path: { ...path, id: DOMAIN_ID },
    }).queryKey,
    makeVerification(status),
  );
  client.setQueryData(
    assistantsEmailAddressesStatusRetrieveOptions({
      path: { ...path, id: ADDRESS_ID },
    }).queryKey,
    {
      address: ADDRESS,
      status: "active",
      usage: {
        sent_today: 0,
        daily_limit: 100,
        received_today: 0,
        sent_this_month: 0,
        received_this_month: 0,
      },
      created_at: "2026-01-01T00:00:00Z",
    },
  );
}

function renderManaged(
  status: DomainVerificationStatusStatusEnum,
): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seedClient(client, status);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EmailManagedContent
          assistantId={ASSISTANT_ID}
          assistantHandle={SUBDOMAIN}
          emailRootDomain={ROOT_DOMAIN}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

function confirmRepairButton(): HTMLButtonElement | null {
  return document.querySelector("[data-confirm-dialog-confirm]");
}

function verificationRefetchInterval(
  client: QueryClient,
):
  | number
  | false
  | ((query: {
      state: { data?: { status?: DomainVerificationStatusStatusEnum } };
    }) => number | false)
  | undefined {
  const query = client.getQueryCache().find({
    queryKey: assistantsDomainsVerificationStatusRetrieveQueryKey({
      path: { assistant_id: ASSISTANT_ID, id: DOMAIN_ID },
    }),
  });
  return query?.observers[0]?.options.refetchInterval as
    | number
    | false
    | ((query: {
        state: { data?: { status?: DomainVerificationStatusStatusEnum } };
      }) => number | false)
    | undefined;
}

beforeEach(() => {
  toastSuccessCalls.length = 0;
  toastErrorCalls.length = 0;
  captureErrorCalls.length = 0;
  provisionCalls.length = 0;
  emailCreateCalls.length = 0;
  verificationStatus = makeVerification("not_started");
  provisionImpl = async () => {
    verificationStatus = makeVerification("pending");
    return {
      data: verificationStatus,
      response: { ok: true },
    };
  };
});

afterEach(() => {
  cleanup();
});

describe("domainVerificationRefetchInterval", () => {
  test("stops polling for not_started, verified, and failed", () => {
    expect(domainVerificationRefetchInterval("not_started")).toBe(false);
    expect(domainVerificationRefetchInterval("verified")).toBe(false);
    expect(domainVerificationRefetchInterval("failed")).toBe(false);
  });

  test("polls pending and other nonterminal provider-check states", () => {
    expect(domainVerificationRefetchInterval("pending")).toBe(
      DOMAIN_VERIFICATION_POLL_MS,
    );
    expect(domainVerificationRefetchInterval("unknown")).toBe(
      DOMAIN_VERIFICATION_POLL_MS,
    );
    expect(domainVerificationRefetchInterval(undefined)).toBe(
      DOMAIN_VERIFICATION_POLL_MS,
    );
  });
});

describe("EmailManagedContent domain setup repair", () => {
  test("existing address plus not_started renders the repair explanation and action", () => {
    renderManaged("not_started");

    expect(screen.getByText(ADDRESS)).toBeTruthy();
    expect(screen.getAllByText("Domain setup required").length).toBeGreaterThan(
      1,
    );
    expect(
      screen.getByText(
        "Your email address is ready, but this domain is not set up with the email provider yet. Complete setup to start sending and receiving mail.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Complete domain setup" }),
    ).toBeTruthy();
  });

  test.each([
    "pending",
    "verified",
    "failed",
    "unknown",
  ] as const)("%s does not render the repair action", (status) => {
    renderManaged(status);

    expect(screen.getByText(ADDRESS)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Complete domain setup" }),
    ).toBeNull();
    expect(
      screen.queryByText(
        "Your email address is ready, but this domain is not set up with the email provider yet. Complete setup to start sending and receiving mail.",
      ),
    ).toBeNull();
  });

  test("confirming repair calls the provision mutation once with the existing ids and no body", async () => {
    renderManaged("not_started");

    fireEvent.click(screen.getByRole("button", { name: "Complete domain setup" }));
    fireEvent.click(confirmRepairButton()!);

    await waitFor(() => {
      expect(provisionCalls).toHaveLength(1);
    });

    const call = provisionCalls[0] as {
      path?: { assistant_id?: string; id?: string };
      body?: unknown;
    };
    expect(call.path).toEqual({
      assistant_id: ASSISTANT_ID,
      id: DOMAIN_ID,
    });
    expect(call.body).toBeUndefined();
    expect(emailCreateCalls).toEqual([]);
  });

  test("duplicate submissions are disabled while pending", async () => {
    let resolveProvision: ((value: {
      data: DomainVerificationStatus;
      response: { ok: boolean };
    }) => void) | undefined;
    provisionImpl = () =>
      new Promise((resolve) => {
        resolveProvision = resolve;
      });

    renderManaged("not_started");
    fireEvent.click(screen.getByRole("button", { name: "Complete domain setup" }));
    fireEvent.click(confirmRepairButton()!);

    await waitFor(() => {
      expect(confirmRepairButton()?.disabled).toBe(true);
    });

    fireEvent.click(confirmRepairButton()!);
    expect(provisionCalls).toHaveLength(1);
    expect(document.body.textContent).toContain("Completing setup…");
    expect(confirmRepairButton()?.disabled).toBe(true);

    resolveProvision?.({
      data: makeVerification("pending"),
      response: { ok: true },
    });
  });

  test("success updates verification state and resumes pending polling", async () => {
    const client = renderManaged("not_started");

    const intervalBefore = verificationRefetchInterval(client);
    expect(typeof intervalBefore).toBe("function");
    if (typeof intervalBefore === "function") {
      expect(
        intervalBefore({ state: { data: { status: "not_started" } } }),
      ).toBe(false);
    }

    fireEvent.click(screen.getByRole("button", { name: "Complete domain setup" }));
    fireEvent.click(confirmRepairButton()!);

    await waitFor(() => {
      expect(screen.getByText("Verifying domain…")).toBeTruthy();
    });

    expect(
      screen.queryByRole("button", { name: "Complete domain setup" }),
    ).toBeNull();
    expect(toastSuccessCalls).toEqual([
      "Domain setup started. Verification usually takes a few minutes.",
    ]);
    expect(emailCreateCalls).toEqual([]);

    const cached = client.getQueryData(
      assistantsDomainsVerificationStatusRetrieveQueryKey({
        path: { assistant_id: ASSISTANT_ID, id: DOMAIN_ID },
      }),
    ) as DomainVerificationStatus | undefined;
    expect(cached?.status).toBe("pending");

    const intervalAfter = verificationRefetchInterval(client);
    expect(typeof intervalAfter).toBe("function");
    if (typeof intervalAfter === "function") {
      expect(intervalAfter({ state: { data: { status: "pending" } } })).toBe(
        DOMAIN_VERIFICATION_POLL_MS,
      );
    }
  });

  test("failure keeps repair available and surfaces a retryable error", async () => {
    provisionImpl = async () => {
      throw { detail: "Email provider is temporarily unavailable." };
    };

    renderManaged("not_started");
    fireEvent.click(screen.getByRole("button", { name: "Complete domain setup" }));
    fireEvent.click(confirmRepairButton()!);

    await waitFor(() => {
      expect(toastErrorCalls).toEqual([
        "Email provider is temporarily unavailable.",
      ]);
    });

    expect(captureErrorCalls[0]?.context).toBe("email_domain_provision");
    expect(screen.getByText(ADDRESS)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Complete domain setup" }),
    ).toBeTruthy();
    expect(confirmRepairButton()).toBeTruthy();
    expect(confirmRepairButton()?.disabled).toBe(false);
    expect(
      screen.getByText("Email provider is temporarily unavailable."),
    ).toBeTruthy();
  });

  test("not_started does not attach a ten-second poll before repair", () => {
    const client = renderManaged("not_started");
    const interval = verificationRefetchInterval(client);
    expect(typeof interval).toBe("function");
    if (typeof interval === "function") {
      expect(
        interval({ state: { data: { status: "not_started" } } }),
      ).toBe(false);
    }
  });
});
