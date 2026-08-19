/**
 * Tests for the Invoices section: the collapsed-by-default toggle plus the
 * cursor-paginated table behind it (Load more, inline error, and retry).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type { Invoice, InvoiceListResponse } from "@/generated/api/types.gen";

let listRetrieveCalls: ({ starting_after?: string } | undefined)[];
let listResult: InvoiceListResponse;
// Pages served for ?starting_after=<cursor> requests, keyed by cursor.
let nextPages: Record<string, InvoiceListResponse>;
// When set, ?starting_after= requests fail with this HTTP status.
let nextPageErrorStatus: number | null;
// When set, cursor-less (first page) requests fail with this HTTP status.
let firstPageErrorStatus: number | null;
// When set, ?starting_after= requests stall until this promise resolves.
let nextPageGate: Promise<void> | null;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingInvoicesRetrieve: async (options?: {
    query?: { starting_after?: string };
  }) => {
    listRetrieveCalls.push(options?.query);
    const cursor = options?.query?.starting_after;
    if (cursor && nextPageGate) {
      await nextPageGate;
    }
    if (cursor && nextPageErrorStatus !== null) {
      return Promise.resolve({
        data: undefined,
        response: { ok: false, status: nextPageErrorStatus },
      });
    }
    if (!cursor && firstPageErrorStatus !== null) {
      return Promise.resolve({
        data: undefined,
        response: { ok: false, status: firstPageErrorStatus },
      });
    }
    return Promise.resolve({
      data: cursor ? nextPages[cursor] : listResult,
      response: { ok: true, status: 200 },
    });
  },
}));

import { InvoicesTable } from "./invoices-table";

function makeInvoice(id: string, overrides?: Partial<Invoice>): Invoice {
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
    ...overrides,
  };
}

/** Five invoices on page 1 with more behind cursor "5": invoices 6 and 7. */
function seedTwoPages(): void {
  listResult = {
    invoices: ["1", "2", "3", "4", "5"].map((id) => makeInvoice(id)),
    has_more: true,
  };
  nextPages["5"] = {
    invoices: [makeInvoice("6"), makeInvoice("7")],
    has_more: false,
  };
}

function renderTable(options?: {
  staleTime?: number;
}): ReturnType<typeof render> & { client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: options?.staleTime ?? 0 },
    },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <InvoicesTable />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

async function openTable(options?: {
  showAll?: boolean;
  staleTime?: number;
}): Promise<ReturnType<typeof renderTable>> {
  const view = renderTable({ staleTime: options?.staleTime });
  fireEvent.click(view.getByTestId("invoices-toggle"));
  await waitFor(() =>
    expect(view.queryByTestId("invoices-table")).not.toBeNull(),
  );
  if (options?.showAll) {
    fireEvent.click(view.getByTestId("invoices-show-more"));
  }
  return view;
}

beforeEach(() => {
  listRetrieveCalls = [];
  listResult = {
    invoices: [makeInvoice("1"), makeInvoice("2")],
    has_more: false,
  };
  nextPages = {};
  nextPageErrorStatus = null;
  firstPageErrorStatus = null;
  nextPageGate = null;
});

afterEach(() => {
  cleanup();
});

describe("InvoicesTable collapse", () => {
  test("starts collapsed: header only, no table, no fetch", () => {
    const { getByText, getByTestId, queryByTestId } = renderTable();

    getByText("Invoices");
    expect(getByTestId("invoices-toggle").textContent).toContain(
      "Show Invoices",
    );
    expect(queryByTestId("invoices-table")).toBeNull();
    expect(queryByTestId("invoices-download-all")).toBeNull();
    expect(listRetrieveCalls.length).toBe(0);
  });

  test("expanding fetches and shows the table; collapsing hides it again", async () => {
    const { getByTestId, queryByTestId, getAllByTestId } = await openTable();

    expect(listRetrieveCalls.length).toBe(1);
    expect(getAllByTestId("invoice-row").length).toBe(2);
    expect(getByTestId("invoices-toggle").textContent).toContain(
      "Hide Invoices",
    );
    getByTestId("invoices-download-all");

    fireEvent.click(getByTestId("invoices-toggle"));
    expect(queryByTestId("invoices-table")).toBeNull();
    expect(queryByTestId("invoices-download-all")).toBeNull();
    expect(getByTestId("invoices-toggle").textContent).toContain(
      "Show Invoices",
    );
  });

  test("empty billing history shows the empty state only once expanded", async () => {
    listResult = { invoices: [], has_more: false };
    const { getByTestId, queryByTestId } = renderTable();

    expect(queryByTestId("invoices-empty")).toBeNull();

    fireEvent.click(getByTestId("invoices-toggle"));

    await waitFor(() => expect(queryByTestId("invoices-empty")).not.toBeNull());
    expect(queryByTestId("invoices-download-all")).toBeNull();
  });
});

describe("InvoicesTable amount formatting", () => {
  test("ISK uses Stripe's two-decimal scaling, not ISO zero-decimal", async () => {
    listResult = {
      invoices: [makeInvoice("1", { currency: "isk", amount_due: 500 })],
      has_more: false,
    };
    const { getAllByTestId } = await openTable();

    const row = getAllByTestId("invoice-row")[0]!;
    expect(row.textContent).toMatch(/5[.,]00/);
    expect(row.textContent).not.toContain("500");
  });

  test("JPY is zero-decimal: minor units render undivided", async () => {
    listResult = {
      invoices: [makeInvoice("1", { currency: "jpy", amount_due: 500 })],
      has_more: false,
    };
    const { getAllByTestId } = await openTable();

    const row = getAllByTestId("invoice-row")[0]!;
    expect(row.textContent).toContain("500");
    expect(row.textContent).not.toMatch(/5[.,]00/);
  });

  test("USD divides minor units by 100 with two decimals", async () => {
    listResult = {
      invoices: [makeInvoice("1", { currency: "usd", amount_due: 1234 })],
      has_more: false,
    };
    const { getAllByTestId } = await openTable();

    const row = getAllByTestId("invoice-row")[0]!;
    expect(row.textContent).toMatch(/12[.,]34/);
  });
});

describe("InvoicesTable pagination", () => {
  test("Load more requests the next page with starting_after and renders both pages", async () => {
    seedTwoPages();
    const { getByTestId, queryByTestId, getAllByTestId } = await openTable();

    expect(getAllByTestId("invoice-row").length).toBe(4);
    expect(queryByTestId("invoices-load-more")).toBeNull();

    fireEvent.click(getByTestId("invoices-show-more"));
    expect(getAllByTestId("invoice-row").length).toBe(5);

    fireEvent.click(getByTestId("invoices-load-more"));

    await waitFor(() => expect(getAllByTestId("invoice-row").length).toBe(7));
    expect(listRetrieveCalls.length).toBe(2);
    expect(listRetrieveCalls[1]).toEqual({ starting_after: "5" });

    expect(queryByTestId("invoices-load-more")).toBeNull();
    expect(getByTestId("invoices-show-more").textContent).toContain(
      "Show less",
    );
  });

  test("Load more is absent when has_more is false", async () => {
    listResult = {
      invoices: ["1", "2", "3", "4", "5"].map((id) => makeInvoice(id)),
      has_more: false,
    };
    const { getByTestId, queryByTestId } = await openTable({ showAll: true });

    expect(queryByTestId("invoices-load-more")).toBeNull();
    expect(getByTestId("invoices-show-more").textContent).toContain(
      "Show less",
    );
    expect(listRetrieveCalls.length).toBe(1);
  });

  test("Show less stays available and works while more server pages remain", async () => {
    listResult = {
      invoices: ["1", "2", "3", "4", "5"].map((id) => makeInvoice(id)),
      has_more: true,
    };
    const { getByTestId, queryByTestId, getAllByTestId } = await openTable({
      showAll: true,
    });

    expect(getByTestId("invoices-show-more").textContent).toContain(
      "Show less",
    );
    expect(queryByTestId("invoices-load-more")).not.toBeNull();

    fireEvent.click(getByTestId("invoices-show-more"));

    expect(getAllByTestId("invoice-row").length).toBe(4);
    expect(getByTestId("invoices-show-more").textContent).toContain(
      "Show more (1 more)",
    );
    expect(queryByTestId("invoices-load-more")).toBeNull();
  });

  test("a failed Load more keeps loaded rows and shows an inline retry", async () => {
    seedTwoPages();
    nextPageErrorStatus = 400;
    const { getByTestId, queryByTestId, queryByText, getAllByTestId } =
      await openTable({ showAll: true });

    fireEvent.click(getByTestId("invoices-load-more"));

    await waitFor(() =>
      expect(queryByTestId("invoices-load-more-error")).not.toBeNull(),
    );
    expect(getAllByTestId("invoice-row").length).toBe(5);
    expect(queryByText("Failed to load invoices.")).toBeNull();

    nextPageErrorStatus = null;
    fireEvent.click(getByTestId("invoices-load-more-retry"));

    // Retry refetches cached pages, then fetches the page that failed.
    await waitFor(() => expect(getAllByTestId("invoice-row").length).toBe(7));
    expect(queryByTestId("invoices-load-more-error")).toBeNull();
    expect(listRetrieveCalls.at(-1)).toEqual({ starting_after: "5" });
  });

  test("Load more is hidden while the inline error is shown", async () => {
    seedTwoPages();
    nextPageErrorStatus = 400;
    const { getByTestId, queryByTestId } = await openTable({ showAll: true });

    fireEvent.click(getByTestId("invoices-load-more"));

    await waitFor(() =>
      expect(queryByTestId("invoices-load-more-error")).not.toBeNull(),
    );
    expect(queryByTestId("invoices-load-more")).toBeNull();
    expect(getByTestId("invoices-load-more-retry")).not.toBeNull();
  });

  test("a settled page failure does not resurrect after collapse and quick reopen", async () => {
    seedTwoPages();
    nextPageErrorStatus = 400;
    const { getByTestId, queryByTestId } = await openTable({
      showAll: true,
      staleTime: 10_000,
    });

    fireEvent.click(getByTestId("invoices-load-more"));
    await waitFor(() =>
      expect(queryByTestId("invoices-load-more-error")).not.toBeNull(),
    );

    nextPageErrorStatus = null;
    fireEvent.click(getByTestId("invoices-toggle"));
    expect(queryByTestId("invoices-table")).toBeNull();
    fireEvent.click(getByTestId("invoices-toggle"));

    await waitFor(() => expect(queryByTestId("invoices-table")).not.toBeNull());
    await waitFor(() =>
      expect(queryByTestId("invoices-load-more-error")).toBeNull(),
    );
    expect(queryByTestId("invoices-load-more")).not.toBeNull();
  });

  test("a page failure resolving after re-expand does not resurrect the error", async () => {
    seedTwoPages();
    nextPageErrorStatus = 400;
    let releaseNextPage: () => void = () => {};
    nextPageGate = new Promise((resolve) => {
      releaseNextPage = resolve;
    });
    const { getByTestId, queryByTestId } = await openTable({ showAll: true });

    fireEvent.click(getByTestId("invoices-load-more"));
    fireEvent.click(getByTestId("invoices-toggle"));
    expect(queryByTestId("invoices-table")).toBeNull();
    fireEvent.click(getByTestId("invoices-toggle"));
    await waitFor(() => expect(queryByTestId("invoices-table")).not.toBeNull());

    releaseNextPage();
    nextPageGate = null;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(queryByTestId("invoices-load-more-error")).toBeNull();
    expect(queryByTestId("invoices-load-more")).not.toBeNull();
  });

  test("a page failure resolving after collapse does not resurrect the error", async () => {
    seedTwoPages();
    nextPageErrorStatus = 400;
    let releaseNextPage: () => void = () => {};
    nextPageGate = new Promise((resolve) => {
      releaseNextPage = resolve;
    });
    const { getByTestId, queryByTestId } = await openTable({ showAll: true });

    fireEvent.click(getByTestId("invoices-load-more"));
    fireEvent.click(getByTestId("invoices-toggle"));
    expect(queryByTestId("invoices-table")).toBeNull();

    releaseNextPage();
    nextPageGate = null;
    await new Promise((resolve) => setTimeout(resolve, 50));

    fireEvent.click(getByTestId("invoices-toggle"));
    await waitFor(() => expect(queryByTestId("invoices-table")).not.toBeNull());
    expect(queryByTestId("invoices-load-more-error")).toBeNull();
    expect(queryByTestId("invoices-load-more")).not.toBeNull();
  });

  test("collapsing and re-expanding clears the inline error", async () => {
    seedTwoPages();
    nextPageErrorStatus = 400;
    const { getByTestId, queryByTestId, getAllByTestId } = await openTable({
      showAll: true,
    });

    fireEvent.click(getByTestId("invoices-load-more"));
    await waitFor(() =>
      expect(queryByTestId("invoices-load-more-error")).not.toBeNull(),
    );

    nextPageErrorStatus = null;
    fireEvent.click(getByTestId("invoices-toggle"));
    expect(queryByTestId("invoices-table")).toBeNull();
    fireEvent.click(getByTestId("invoices-toggle"));

    await waitFor(() => expect(queryByTestId("invoices-table")).not.toBeNull());
    expect(getAllByTestId("invoice-row").length).toBeGreaterThan(0);
    expect(queryByTestId("invoices-load-more-error")).toBeNull();
    expect(queryByTestId("invoices-load-more")).not.toBeNull();
  });

  test("a failed background refetch stays silent and keeps Load more", async () => {
    seedTwoPages();
    const { client, queryByTestId, getAllByTestId } = await openTable({
      showAll: true,
    });

    expect(queryByTestId("invoices-load-more")).not.toBeNull();

    firstPageErrorStatus = 500;
    await client.refetchQueries();

    await waitFor(() => expect(listRetrieveCalls.length).toBe(2));
    expect(getAllByTestId("invoice-row").length).toBe(5);
    expect(queryByTestId("invoices-load-more-error")).toBeNull();
    expect(queryByTestId("invoices-load-more")).not.toBeNull();
  });

  test("a short first page with has_more still offers Load more", async () => {
    listResult = {
      invoices: [makeInvoice("1"), makeInvoice("2")],
      has_more: true,
    };
    nextPages["2"] = {
      invoices: ["3", "4", "5"].map((id) => makeInvoice(id)),
      has_more: false,
    };
    const { getByTestId, queryByTestId, getAllByTestId } = await openTable();

    // Two rows, nothing hidden locally, but the server has more:
    // Load more must render so the rest is reachable.
    expect(queryByTestId("invoices-show-more")).toBeNull();
    fireEvent.click(getByTestId("invoices-load-more"));

    await waitFor(() => expect(getAllByTestId("invoice-row").length).toBe(4));
    expect(getByTestId("invoices-show-more").textContent).toContain(
      "Show more (1 more)",
    );
    expect(queryByTestId("invoices-load-more")).toBeNull();
  });
});
