import { Download, ExternalLink, FileText, Loader2 } from "lucide-react";
import { useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { organizationsBillingInvoicesRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import {
  organizationsBillingInvoicesDownloadRetrieve,
  organizationsBillingInvoicesRetrieve,
} from "@/generated/api/sdk.gen";
import type { InvoiceListResponse } from "@/generated/api/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { formatFriendlyDate } from "@/utils/format-date";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tag, type TagTone } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";

const EMPTY_RESPONSE: InvoiceListResponse = { invoices: [] };

/** Map a Stripe invoice status to a Tag tone for the status chip. */
function statusTone(status: string | null): TagTone {
  switch (status) {
    case "paid":
      return "positive";
    case "open":
      return "warning";
    case "uncollectible":
      return "negative";
    default:
      // draft, void, or null
      return "neutral";
  }
}

/**
 * Format a minor-unit amount in its currency. Stripe amounts are in the
 * currency's minor unit, whose exponent varies (USD has 2, JPY/KRW have 0),
 * so we derive the divisor from the currency rather than assuming cents.
 */
function formatAmount(minorUnits: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    const formatter = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
    });
    const exponent = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(minorUnits / 10 ** exponent);
  } catch {
    // Unknown currency code: best-effort, assume a 2-digit minor unit.
    return `${(minorUnits / 100).toFixed(2)} ${code}`;
  }
}

/** Format a Unix-seconds timestamp as a human-readable date. */
function formatDate(unixSeconds: number): string {
  return formatFriendlyDate(new Date(unixSeconds * 1000), {
    alwaysShowYear: true,
  });
}

/**
 * Trigger a PDF download in a new tab. Stripe's `invoice_pdf` URLs serve the
 * file with an attachment disposition, so the browser downloads rather than
 * navigates.
 */
function downloadPdf(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

interface InvoicesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InvoicesModal({ open, onOpenChange }: InvoicesModalProps) {
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);

  const invoicesQuery = useQuery({
    queryKey: organizationsBillingInvoicesRetrieveQueryKey(),
    enabled: open,
    queryFn: async ({ signal }) => {
      const { data, response } = await organizationsBillingInvoicesRetrieve({
        throwOnError: false,
        signal,
      });
      // A 404 means there's no billing history (no Stripe customer yet) —
      // treat it as an empty list and render the empty state, not an error.
      if (response?.status === 404) {
        return EMPTY_RESPONSE;
      }
      if (!response?.ok || !data) {
        throw new Error(
          `Failed to load invoices (${response?.status ?? "network error"})`,
        );
      }
      return data;
    },
  });

  const invoices = invoicesQuery.data?.invoices ?? [];
  const hasDownloadablePdfs = invoices.some(
    (invoice) => invoice.invoice_pdf != null,
  );

  async function downloadAllInvoices(): Promise<void> {
    setIsDownloadingAll(true);
    try {
      // The generated clients are pinned to `parseAs: "json"` (see
      // api-interceptors.ts), so blob downloads must opt back into binary
      // parsing or the zip body is run through JSON.parse and fails.
      const { data, response } =
        await organizationsBillingInvoicesDownloadRetrieve({
          throwOnError: false,
          parseAs: "blob",
        });
      if (!response?.ok || !(data instanceof Blob)) {
        throw new Error(
          `Failed to download invoices (${response?.status ?? "network error"})`,
        );
      }
      const { saveFile } = await import("@/runtime/native-file");
      await saveFile(data, "invoices.zip");
    } catch (error) {
      captureError(error, { context: "download_all_invoices" });
      toast.error("Failed to download invoices.");
    } finally {
      setIsDownloadingAll(false);
    }
  }

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content size="lg">
        <Modal.Header>
          <Modal.Title icon={FileText}>Invoices</Modal.Title>
          <Modal.Description>
            Your billing history. Open an invoice for full details or download
            it as a PDF.
          </Modal.Description>
        </Modal.Header>

        <Modal.Body>
          {invoicesQuery.isLoading ? (
            <div className="flex items-center gap-2 py-6 text-[var(--content-tertiary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <Typography as="span" variant="body-small-default">
                Loading invoices...
              </Typography>
            </div>
          ) : invoicesQuery.isError ? (
            <Notice tone="error">Failed to load invoices.</Notice>
          ) : invoices.length === 0 ? (
            <Typography
              as="p"
              variant="body-small-default"
              className="py-6 text-center text-[var(--content-tertiary)]"
              data-testid="invoices-empty"
            >
              No Invoices Found
            </Typography>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--border-base)]">
              {invoices.map((invoice) => (
                <li
                  key={invoice.id}
                  className="flex items-center gap-3 py-3"
                  data-testid="invoice-row"
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <Typography
                        variant="body-medium-default"
                        as="span"
                        className="text-[var(--content-default)]"
                      >
                        {invoice.number ?? "Invoice"}
                      </Typography>
                      {invoice.status && (
                        <Tag tone={statusTone(invoice.status)}>
                          {invoice.status}
                        </Tag>
                      )}
                    </div>
                    <Typography
                      variant="body-small-default"
                      as="div"
                      className="text-[var(--content-tertiary)]"
                    >
                      {formatDate(invoice.created)} ·{" "}
                      {formatAmount(invoice.amount_due, invoice.currency)}
                    </Typography>
                  </div>
                  {invoice.hosted_invoice_url && (
                    <Button
                      asChild
                      variant="ghost"
                      size="compact"
                      leftIcon={<ExternalLink />}
                    >
                      <a
                        href={invoice.hosted_invoice_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        View
                      </a>
                    </Button>
                  )}
                  {invoice.invoice_pdf && (
                    <Button
                      variant="ghost"
                      size="compact"
                      iconOnly={<Download />}
                      aria-label="Download invoice PDF"
                      onClick={() => downloadPdf(invoice.invoice_pdf!)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Modal.Body>

        <Modal.Footer>
          {hasDownloadablePdfs && (
            <Button
              variant="outlined"
              leftIcon={
                isDownloadingAll ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Download />
                )
              }
              disabled={isDownloadingAll}
              onClick={downloadAllInvoices}
            >
              Download all
            </Button>
          )}
          <Modal.Close asChild>
            <Button variant="primary">Done</Button>
          </Modal.Close>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
