/**
 * Tests for the InvoicesModal "Download all" zip flow.
 *
 * Strategy: pre-seed the invoice list into the React Query cache so the modal
 * renders synchronously, and mock the generated SDK's zip download plus the
 * shared `downloadBlob` helper and the toast module. Covers: one SDK call →
 * one saved `invoices.zip` (never one download per invoice), the error toast
 * on a non-OK response, and the disabled button while the request is in
 * flight.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import * as sdkGen from "@/generated/api/sdk.gen";
import { organizationsBillingInvoicesRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { Invoice } from "@/generated/api/types.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

type DownloadResult = {
  data?: Blob;
  response: { ok: boolean; status: number };
};

function okDownloadResult(): DownloadResult {
  return {
    data: new Blob(["zip"], { type: "application/zip" }),
    response: { ok: true, status: 200 },
  };
}

let downloadRetrieveCalls = 0;
let downloadRetrieveResult: () => Promise<DownloadResult> = async () =>
  okDownloadResult();

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingInvoicesDownloadRetrieve: () => {
    downloadRetrieveCalls += 1;
    return downloadRetrieveResult();
  },
}));

let downloadBlobCalls: { blob: Blob; filename: string }[] = [];

mock.module("@/utils/download-blob", () => ({
  downloadBlob: (blob: Blob, filename: string) => {
    downloadBlobCalls.push({ blob, filename });
  },
}));

let captureErrorCalls: { error: unknown; context: string }[] = [];

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: (error: unknown, opts: { context: string }) => {
    captureErrorCalls.push({ error, context: opts.context });
  },
}));

let toastErrorCalls: string[] = [];

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

import { InvoicesModal } from "./invoices-modal";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

function renderModal(): ReturnType<typeof render> {
  // staleTime: Infinity keeps the pre-seeded list from refetching on mount,
  // so the test never touches the network.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(organizationsBillingInvoicesRetrieveQueryKey(), {
    invoices: [makeInvoice("1"), makeInvoice("2"), makeInvoice("3")],
  });
  return render(
    <QueryClientProvider client={client}>
      <InvoicesModal open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

function getDownloadAllButton(
  result: ReturnType<typeof render>,
): HTMLButtonElement {
  return result.getByText("Download all").closest("button")!;
}

beforeEach(() => {
  downloadRetrieveCalls = 0;
  downloadRetrieveResult = async () => okDownloadResult();
  downloadBlobCalls = [];
  captureErrorCalls = [];
  toastErrorCalls = [];
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InvoicesModal download all", () => {
  test("clicking Download all fetches the zip once and saves a single invoices.zip", async () => {
    const result = renderModal();

    fireEvent.click(getDownloadAllButton(result));

    await waitFor(() => {
      if (downloadBlobCalls.length === 0) {
        throw new Error("downloadBlob not called");
      }
    });

    // One SDK call and one saved file — never one download per invoice.
    expect(downloadRetrieveCalls).toBe(1);
    expect(downloadBlobCalls).toHaveLength(1);
    expect(downloadBlobCalls[0]!.filename).toBe("invoices.zip");
    expect(toastErrorCalls).toHaveLength(0);
  });

  test("a non-OK response shows the error toast and saves nothing", async () => {
    downloadRetrieveResult = () =>
      Promise.resolve({ response: { ok: false, status: 404 } });
    const result = renderModal();

    fireEvent.click(getDownloadAllButton(result));

    await waitFor(() => {
      if (toastErrorCalls.length === 0) {
        throw new Error("toast.error not called");
      }
    });

    expect(toastErrorCalls).toEqual(["Failed to download invoices."]);
    expect(downloadBlobCalls).toHaveLength(0);
    expect(captureErrorCalls).toHaveLength(1);
    expect(captureErrorCalls[0]!.context).toBe("download_all_invoices");
  });

  test("a thrown network error shows the error toast and saves nothing", async () => {
    downloadRetrieveResult = () => Promise.reject(new Error("network down"));
    const result = renderModal();

    fireEvent.click(getDownloadAllButton(result));

    await waitFor(() => {
      if (toastErrorCalls.length === 0) {
        throw new Error("toast.error not called");
      }
    });

    expect(toastErrorCalls).toEqual(["Failed to download invoices."]);
    expect(downloadBlobCalls).toHaveLength(0);
    expect(captureErrorCalls).toHaveLength(1);
    expect(captureErrorCalls[0]!.context).toBe("download_all_invoices");
  });

  test("the button is disabled while the request is in flight and re-enabled after", async () => {
    let resolveDownload: (value: DownloadResult) => void;
    downloadRetrieveResult = () =>
      new Promise<DownloadResult>((resolve) => {
        resolveDownload = resolve;
      });
    const result = renderModal();
    const button = getDownloadAllButton(result);

    expect(button.disabled).toBe(false);

    fireEvent.click(button);

    await waitFor(() => {
      if (!getDownloadAllButton(result).disabled) {
        throw new Error("button not disabled while in flight");
      }
    });

    resolveDownload!(okDownloadResult());

    await waitFor(() => {
      if (getDownloadAllButton(result).disabled) {
        throw new Error("button still disabled after resolution");
      }
    });
    expect(downloadBlobCalls).toHaveLength(1);
  });
});
