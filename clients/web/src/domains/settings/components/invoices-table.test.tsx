/**
 * Tests for the collapsed-by-default Invoices section.
 *
 * The section renders just its header plus a "Show invoices" toggle in the
 * top-right corner; the table (and its backing fetch) only materializes once
 * the toggle is clicked, and collapses again on a second click.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type { Invoice, InvoiceListResponse } from "@/generated/api/types.gen";

let listRetrieveCalls = 0;
let listResult: InvoiceListResponse = { invoices: [] };

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingInvoicesRetrieve: () => {
    listRetrieveCalls += 1;
    return Promise.resolve({
      data: listResult,
      response: { ok: true, status: 200 },
    });
  },
}));

import { InvoicesTable } from "./invoices-table";

function makeInvoice(id: string): Invoice {
  return {
    id,
    number: `INV-${id}`,
    status: "paid",
    currency: "usd",
    amount_due: 1000,
    amount_paid: 1000,
    amount_remaining: 0,
    created: 1735689600,
    hosted_invoice_url: `https://invoice.example.com/${id}`,
    invoice_pdf: `https://invoice.example.com/${id}.pdf`,
  };
}

function renderTable(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <InvoicesTable />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listRetrieveCalls = 0;
  listResult = { invoices: [makeInvoice("1"), makeInvoice("2")] };
});

afterEach(() => {
  cleanup();
});

describe("InvoicesTable collapse", () => {
  test("starts collapsed: header only, no table, no fetch", () => {
    const { getByText, getByTestId, queryByTestId } = renderTable();

    getByText("Invoices");
    getByText("Your billing history.");
    expect(getByTestId("invoices-toggle").textContent).toContain(
      "Show invoices",
    );
    expect(queryByTestId("invoices-table")).toBeNull();
    expect(queryByTestId("invoices-download-all")).toBeNull();
    expect(listRetrieveCalls).toBe(0);
  });

  test("expanding fetches and shows the table; collapsing hides it again", async () => {
    const { getByTestId, queryByTestId, getAllByTestId } = renderTable();

    fireEvent.click(getByTestId("invoices-toggle"));

    await waitFor(() => expect(queryByTestId("invoices-table")).not.toBeNull());
    expect(listRetrieveCalls).toBe(1);
    expect(getAllByTestId("invoice-row").length).toBe(2);
    expect(getByTestId("invoices-toggle").textContent).toContain(
      "Hide invoices",
    );
    getByTestId("invoices-download-all");

    fireEvent.click(getByTestId("invoices-toggle"));
    expect(queryByTestId("invoices-table")).toBeNull();
    expect(queryByTestId("invoices-download-all")).toBeNull();
    expect(getByTestId("invoices-toggle").textContent).toContain(
      "Show invoices",
    );
  });

  test("empty billing history shows the empty state only once expanded", async () => {
    listResult = { invoices: [] };
    const { getByTestId, queryByTestId } = renderTable();

    expect(queryByTestId("invoices-empty")).toBeNull();

    fireEvent.click(getByTestId("invoices-toggle"));

    await waitFor(() => expect(queryByTestId("invoices-empty")).not.toBeNull());
    // No invoices — the Download all button stays hidden even when expanded.
    expect(queryByTestId("invoices-download-all")).toBeNull();
  });
});
