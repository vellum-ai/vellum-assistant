/**
 * Tests for the AutoTopUpCard repeated-decline cutoff notice: when the backend
 * reports `disabled_due_to_repeated_failures`, the card renders a tailored
 * warning telling the user to add a new payment method; a normally-disabled
 * config renders no such notice.
 *
 * Strategy: pre-populate the React Query cache so the card's `useQuery` resolves
 * synchronously — `renderToStaticMarkup` is single-pass, so a pending query
 * would otherwise report `isLoading` and render the spinner.
 */

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import { organizationsBillingAutoTopUpRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";

import { AutoTopUpCard, DISABLED_CONFIG } from "./auto-top-up-card";

function renderCard(config: AutoTopUpConfigResponse): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    organizationsBillingAutoTopUpRetrieveQueryKey(),
    config,
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AutoTopUpCard />
    </QueryClientProvider>,
  );
}

describe("AutoTopUpCard repeated-decline cutoff notice", () => {
  test("renders the cutoff notice when disabled after repeated declines", () => {
    const html = renderCard({
      ...DISABLED_CONFIG,
      has_payment_method: false,
      disabled_due_to_repeated_failures: true,
    });
    expect(html).toContain("auto-top-up-declined-cutoff");
    expect(html).toContain("We paused automatic reloads after several declined");
  });

  test("does not render the cutoff notice for a normally-disabled config", () => {
    const html = renderCard({
      ...DISABLED_CONFIG,
      has_payment_method: false,
      disabled_due_to_repeated_failures: false,
    });
    expect(html).not.toContain("auto-top-up-declined-cutoff");
  });
});
