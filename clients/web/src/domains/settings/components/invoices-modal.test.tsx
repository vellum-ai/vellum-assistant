import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import * as sdkGen from "@/generated/api/sdk.gen";
import { organizationsBillingInvoicesRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { Invoice } from "@/generated/api/types.gen";

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
let downloadRetrieveResult: () => Promise<DownloadResult>;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingInvoicesDownloadRetrieve: () => {
    downloadRetrieveCalls += 1;
    return downloadRetrieveResult();
  },
}));

let saveFileCalls: { source: Blob | string; filename: string }[] = [];

mock.module("@/runtime/native-file", () => ({
  saveFile: async (source: Blob | string, filename: string) => {
    saveFileCalls.push({ source, filename });
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
    error: (message: string) => {
      toastErrorCalls.push(message);
    },
  },
}));

import { InvoicesModal } from "./invoices-modal";

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
  return result.getByRole("button", {
    name: "Download all",
  }) as HTMLButtonElement;
}

beforeEach(() => {
  downloadRetrieveCalls = 0;
  downloadRetrieveResult = async () => okDownloadResult();
  saveFileCalls = [];
  captureErrorCalls = [];
  toastErrorCalls = [];
});

afterEach(cleanup);

describe("InvoicesModal download all", () => {
  test("clicking Download all fetches the zip once and saves a single invoices.zip", async () => {
    const result = renderModal();

    fireEvent.click(getDownloadAllButton(result));

    await waitFor(() => {
      if (saveFileCalls.length === 0) {
        throw new Error("saveFile not called");
      }
    });

    expect(downloadRetrieveCalls).toBe(1);
    expect(saveFileCalls).toHaveLength(1);
    expect(saveFileCalls[0]!.source).toBeInstanceOf(Blob);
    expect(saveFileCalls[0]!.filename).toBe("invoices.zip");
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
    expect(saveFileCalls).toHaveLength(0);
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
    expect(saveFileCalls).toHaveLength(0);
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
    expect(saveFileCalls).toHaveLength(1);
  });
});
