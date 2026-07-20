/**
 * DomainStep query invalidation: registering a domain must refresh the caches
 * the "Finish Pro setup" nudge reads (domains list + onboarding state) in
 * addition to the assistants list.
 *
 * Strategy mirrors billing-page.test.tsx: mock the generated SDK so the
 * targeted assistant loads (prefilling the subdomain from its handle) and the
 * domain mutation resolves, then spy on the query client's invalidations.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  assistantsDomainsListQueryKey,
  assistantsListQueryKey,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import * as sdkGen from "@/generated/api/sdk.gen";
import type { Assistant } from "@/generated/api/types.gen";

let domainCreateCalls = 0;
let domainsListPaths: string[] = [];

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  assistantsActiveRetrieve: () =>
    Promise.resolve({
      data: { id: "assistant-1", handle: "velly" } as unknown as Assistant,
      response: { ok: true },
    }),
  assistantsRetrieve: (opts: { path: { id: string } }) =>
    Promise.resolve({
      data: { id: opts.path.id, handle: "velly" } as unknown as Assistant,
      response: { ok: true },
    }),
  assistantsDomainsList: (opts: { path?: { assistant_id?: string } }) => {
    if (opts?.path?.assistant_id) {
      domainsListPaths.push(opts.path.assistant_id);
    }
    return Promise.resolve({
      data: { count: 0, next: null, previous: null, results: [] },
      response: { ok: true },
    });
  },
  organizationsBillingSubscriptionOnboardingDomainCreate: () => {
    domainCreateCalls += 1;
    return Promise.resolve({ data: {}, response: { ok: true } });
  },
}));

const { DomainStep } = await import("./domain-step");

beforeEach(() => {
  domainCreateCalls = 0;
  domainsListPaths = [];
});

afterEach(() => {
  cleanup();
});

describe("DomainStep domain registration", () => {
  test("invalidates the domains-list and onboarding caches on success", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = spyOn(client, "invalidateQueries");

    const { getByTestId } = render(
      <QueryClientProvider client={client}>
        <DomainStep onExit={() => {}} />
      </QueryClientProvider>,
    );

    // The active assistant's handle prefills the subdomain, enabling the CTA.
    await waitFor(() => {
      const btn = getByTestId("onboarding-domain-set") as HTMLButtonElement;
      if (btn.disabled) {
        throw new Error("button not enabled yet");
      }
    });

    fireEvent.click(getByTestId("onboarding-domain-set"));

    await waitFor(() => expect(domainCreateCalls).toBe(1));

    const invalidatedKeys = invalidateSpy.mock.calls.map((call) =>
      JSON.stringify(call[0]?.queryKey),
    );
    expect(invalidatedKeys).toContain(JSON.stringify(assistantsListQueryKey()));
    expect(invalidatedKeys).toContain(
      JSON.stringify(
        assistantsDomainsListQueryKey({
          path: { assistant_id: "assistant-1" },
        }),
      ),
    );
    expect(invalidatedKeys).toContain(
      JSON.stringify(
        organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
      ),
    );
  });

  test("checks domains on the assistant id the wizard passes in", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <DomainStep onExit={() => {}} assistantId="assistant-2" />
      </QueryClientProvider>,
    );

    // The provisioning target assistant wins over the active one.
    await waitFor(() => expect(domainsListPaths).toContain("assistant-2"));
    expect(domainsListPaths).not.toContain("assistant-1");
  });
});

describe("DomainStep stalled resize", () => {
  test("stalledAction swaps the busy notice for the warning and apply controls", async () => {
    const onApply = mock(() => {});
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { getByText, getByTestId, queryByText } = render(
      <QueryClientProvider client={client}>
        <DomainStep
          onExit={() => {}}
          machineBusy
          stalledAction={{ onApply, pending: false, error: null }}
        />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(getByTestId("domain-stalled-apply")).toBeTruthy(),
    );
    expect(
      getByText(/We couldn't finish your machine upgrade automatically/),
    ).toBeTruthy();
    expect(
      queryByText(
        "Your assistant is restarting — you can set the domain in a moment.",
      ),
    ).toBeNull();

    fireEvent.click(getByTestId("domain-stalled-apply"));
    expect(onApply).toHaveBeenCalledTimes(1);

    // The guardian-channel submit stays locked while the machine is busy.
    await waitFor(() =>
      expect(
        (getByTestId("onboarding-domain-set") as HTMLButtonElement).disabled,
      ).toBe(true),
    );
  });

  test("plain machine-busy keeps the neutral notice without apply controls", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { getByText, queryByTestId } = render(
      <QueryClientProvider client={client}>
        <DomainStep onExit={() => {}} machineBusy />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(
        getByText(
          "Your assistant is restarting — you can set the domain in a moment.",
        ),
      ).toBeTruthy(),
    );
    expect(queryByTestId("domain-stalled-apply")).toBeNull();
  });
});
