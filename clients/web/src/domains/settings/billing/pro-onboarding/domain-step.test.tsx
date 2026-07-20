/**
 * DomainStep query invalidation: registering a domain must refresh the caches
 * the "Finish Pro setup" nudge reads (domains list + onboarding state) in
 * addition to the assistants list.
 *
 * Strategy mirrors billing-page.test.tsx: mock the generated SDK so the active
 * assistant loads (prefilling the subdomain from its handle) and the domain
 * mutation resolves, then spy on the query client's invalidations.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
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

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  assistantsActiveRetrieve: () =>
    Promise.resolve({
      data: { id: "assistant-1", handle: "velly" } as unknown as Assistant,
      response: { ok: true },
    }),
  assistantsDomainsList: () =>
    Promise.resolve({
      data: { count: 0, next: null, previous: null, results: [] },
      response: { ok: true },
    }),
  organizationsBillingSubscriptionOnboardingDomainCreate: () => {
    domainCreateCalls += 1;
    return Promise.resolve({ data: {}, response: { ok: true } });
  },
}));

const { DomainStep } = await import("./domain-step");

afterEach(() => {
  cleanup();
});

describe("DomainStep domain registration", () => {
  test("invalidates the domains-list and onboarding caches on success", async () => {
    domainCreateCalls = 0;
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
});
