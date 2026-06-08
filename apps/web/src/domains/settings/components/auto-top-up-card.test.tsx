/**
 * Tests for the AutoTopUpCard repeated-decline cutoff notice and its enable
 * gate:
 *  - When the backend reports `disabled_due_to_repeated_failures` on a disabled
 *    config, the card renders a tailored warning telling the user to add a new
 *    payment method; a normally-disabled config renders no such notice.
 *  - The cutoff notice is suppressed when the config is `enabled` (defensive
 *    guard against contradictory copy from a raced/stale response).
 *  - Toggling Enable on while the cutoff flag is set (even with a saved PM)
 *    does NOT open the form — the user can't re-enable with the cut-off card.
 *
 * Strategy: the render-only cases pre-populate the React Query cache so the
 * card's `useQuery` resolves synchronously — `renderToStaticMarkup` is
 * single-pass, so a pending query would otherwise report `isLoading` and render
 * the spinner. The enable-gate case needs a real DOM to drive a click, so it
 * uses @testing-library/react (happy-dom is registered via the test preload).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { organizationsBillingAutoTopUpRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";

import { AutoTopUpCard, DISABLED_CONFIG } from "./auto-top-up-card";

function makeClient(config: AutoTopUpConfigResponse): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(organizationsBillingAutoTopUpRetrieveQueryKey(), config);
  return client;
}

function renderCard(config: AutoTopUpConfigResponse): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={makeClient(config)}>
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

  test("suppresses the cutoff notice when the config is enabled", () => {
    // Defensive guard (Finding 2): the backend treats the cutoff as terminal
    // (cutoff ⇒ enabled=false), but if a raced/stale response carried both
    // `enabled: true` and the flag, the enabled summary and the cutoff notice
    // must stay mutually exclusive — show the summary, not the contradictory
    // "we paused reloads" copy.
    const html = renderCard({
      ...DISABLED_CONFIG,
      enabled: true,
      threshold_usd: "50.00",
      amount_usd: "200.00",
      has_payment_method: true,
      disabled_due_to_repeated_failures: true,
    });
    expect(html).not.toContain("auto-top-up-declined-cutoff");
    expect(html).toContain("auto-top-up-summary");
  });

  test("renders the cutoff notice (not the enabled summary) when cut off with a saved PM", () => {
    // Finding 1 state: the saved card is still on file (`has_payment_method:
    // true`) but the backend cut auto-reload off after repeated declines. The
    // cutoff notice is the single message; the enabled summary is absent.
    const html = renderCard({
      ...DISABLED_CONFIG,
      enabled: false,
      has_payment_method: true,
      disabled_due_to_repeated_failures: true,
    });
    expect(html).toContain("auto-top-up-declined-cutoff");
    expect(html).not.toContain("auto-top-up-summary");
  });
});

describe("AutoTopUpCard enable gate", () => {
  afterEach(cleanup);

  test("toggling Enable on while cut off (with a saved PM) does not open the form", () => {
    // Finding 1: even though a PM is on file, the repeated-decline cutoff must
    // block re-enabling with the same cut-off card. The toggle must not enter
    // form mode (no AutoTopUpForm / Save button), and the cutoff notice stays.
    const config: AutoTopUpConfigResponse = {
      ...DISABLED_CONFIG,
      enabled: false,
      has_payment_method: true,
      disabled_due_to_repeated_failures: true,
    };

    const { container, getByLabelText } = render(
      <QueryClientProvider client={makeClient(config)}>
        <AutoTopUpCard />
      </QueryClientProvider>,
    );
    const form = () =>
      container.querySelector('[data-testid="auto-top-up-save-button"]');

    // The form is not present before the click.
    expect(form()).toBeNull();

    fireEvent.click(getByLabelText("Enable Auto-Reload"));

    // The enable gate tripped: still no form, and the cutoff notice persists.
    expect(form()).toBeNull();
    expect(
      container.querySelector('[data-testid="auto-top-up-declined-cutoff"]'),
    ).not.toBeNull();
  });

  test("toggling Enable on with a saved PM and no cutoff opens the form", () => {
    // Control case: without the cutoff flag, a saved PM lets the user enter the
    // configure form — confirms the gate only blocks the cut-off state.
    const config: AutoTopUpConfigResponse = {
      ...DISABLED_CONFIG,
      enabled: false,
      has_payment_method: true,
      disabled_due_to_repeated_failures: false,
    };

    const { container, getByLabelText } = render(
      <QueryClientProvider client={makeClient(config)}>
        <AutoTopUpCard />
      </QueryClientProvider>,
    );
    const form = () =>
      container.querySelector('[data-testid="auto-top-up-save-button"]');

    expect(form()).toBeNull();

    fireEvent.click(getByLabelText("Enable Auto-Reload"));

    expect(form()).not.toBeNull();
  });
});
