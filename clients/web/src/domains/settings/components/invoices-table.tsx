import {
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { useState } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";

import { organizationsBillingInvoicesRetrieveInfiniteQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import {
  organizationsBillingInvoicesDownloadRetrieve,
  organizationsBillingInvoicesRetrieve,
} from "@/generated/api/sdk.gen";
import type { InvoiceListResponse } from "@/generated/api/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { assertHasResponse, toApiError } from "@/utils/api-errors";
import { formatFriendlyDate } from "@/utils/format-date";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tag, type TagTone } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";

const EMPTY_RESPONSE: InvoiceListResponse = { invoices: [], has_more: false };

const INITIAL_VISIBLE = 4;

function statusTone(status: string | null): TagTone {
  switch (status) {
    case "paid":
      return "positive";
    case "open":
      return "warning";
    case "uncollectible":
      return "negative";
    default:
      return "neutral";
  }
}

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
    return `${(minorUnits / 100).toFixed(2)} ${code}`;
  }
}

function formatDate(unixSeconds: number): string {
  return formatFriendlyDate(new Date(unixSeconds * 1000), {
    alwaysShowYear: true,
  });
}

function downloadPdf(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function InvoicesTable() {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);

  const invoicesQuery = useInfiniteQuery({
    // The table hides behind the Show invoices toggle, so don't fetch
    // billing history for a section the user may never open.
    enabled: expanded,
    queryKey: organizationsBillingInvoicesRetrieveInfiniteQueryKey(),
    queryFn: async ({ signal, pageParam }) => {
      const { data, error, response } =
        await organizationsBillingInvoicesRetrieve({
          throwOnError: false,
          signal,
          query: pageParam ? { starting_after: pageParam } : undefined,
        });
      if (response?.status === 404) {
        return EMPTY_RESPONSE;
      }
      assertHasResponse(response, error, "Failed to load invoices.");
      if (!response.ok || !data) {
        // The stale starting_after cursor 400 is a 4xx, so the global retry
        // predicate won't retry it.
        throw toApiError(error, response);
      }
      return data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.has_more ? lastPage.invoices.at(-1)?.id : undefined,
  });

  const invoices = invoicesQuery.data?.pages.flatMap((p) => p.invoices) ?? [];
  const visibleInvoices = showAll
    ? invoices
    : invoices.slice(0, INITIAL_VISIBLE);
  const hasHiddenRows = invoices.length > INITIAL_VISIBLE;
  // Both flags stay true through the whole retry: a plain refetch clears the
  // fetchMore meta (isFetchNextPageError drops), at which point the still-set
  // error with data present reads as isRefetchError.
  const showLoadMoreError =
    invoicesQuery.isFetchNextPageError || invoicesQuery.isRefetchError;
  // "Load more" renders whenever every locally loaded row is already visible
  // but the server still has more, so remaining invoices are always reachable.
  // Retry supersedes it while the inline error is up.
  const showLoadMore =
    (showAll || !hasHiddenRows) &&
    invoicesQuery.hasNextPage &&
    !showLoadMoreError;

  function retryLoadMore(): void {
    // refetch() recomputes every cached page's cursor, healing a stale
    // starting_after, then fetchNextPage() fetches the page the user asked
    // for (a no-op if the refreshed pages already exhaust the list).
    void invoicesQuery
      .refetch()
      .then((result) =>
        result.isError ? undefined : invoicesQuery.fetchNextPage(),
      );
  }

  async function downloadAllInvoices(): Promise<void> {
    setIsDownloadingAll(true);
    try {
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
    <Card padding="md">
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Typography
              as="h2"
              variant="title-medium"
              className="text-[var(--content-default)]"
            >
              Invoices
            </Typography>
            <Typography
              as="p"
              variant="body-small-default"
              className="mt-2 text-[var(--content-tertiary)]"
            >
              Your billing history.
            </Typography>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {expanded && invoices.length > 0 && (
              <Button
                variant="outlined"
                leftIcon={
                  isDownloadingAll ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )
                }
                onClick={downloadAllInvoices}
                disabled={isDownloadingAll}
                data-testid="invoices-download-all"
              >
                Download all
              </Button>
            )}
            <Button
              variant="outlined"
              leftIcon={
                expanded ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )
              }
              onClick={() => setExpanded((v) => !v)}
              data-testid="invoices-toggle"
            >
              {expanded ? "Hide invoices" : "Show invoices"}
            </Button>
          </div>
        </div>

        {!expanded ? null : invoicesQuery.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-[var(--content-tertiary)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            <Typography as="span" variant="body-small-default">
              Loading invoices...
            </Typography>
          </div>
        ) : invoicesQuery.isLoadingError ? (
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
          <>
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="invoices-table">
                <thead>
                  <tr className="border-b border-[var(--border-base)] text-left">
                    <th className="pb-2 pr-4 text-body-small-default text-[var(--content-tertiary)]">
                      Date
                    </th>
                    <th className="pb-2 pr-4 text-body-small-default text-[var(--content-tertiary)]">
                      Amount
                    </th>
                    <th className="pb-2 pr-4 text-body-small-default text-[var(--content-tertiary)]">
                      Status
                    </th>
                    <th className="pb-2 text-body-small-default text-[var(--content-tertiary)]">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleInvoices.map((invoice) => (
                    <tr
                      key={invoice.id}
                      className="border-b border-[var(--border-base)] last:border-0"
                      data-testid="invoice-row"
                    >
                      <td className="py-3 pr-4">
                        <Typography
                          as="span"
                          variant="body-small-default"
                          className="text-[var(--content-secondary)]"
                        >
                          {formatDate(invoice.created)}
                        </Typography>
                      </td>
                      <td className="py-3 pr-4">
                        <Typography
                          as="span"
                          variant="body-small-default"
                          className="text-[var(--content-secondary)]"
                        >
                          {formatAmount(invoice.amount_due, invoice.currency)}
                        </Typography>
                      </td>
                      <td className="py-3 pr-4">
                        {invoice.status && (
                          <Tag tone={statusTone(invoice.status)}>
                            {invoice.status}
                          </Tag>
                        )}
                      </td>
                      <td className="py-3">
                        <div className="flex items-center gap-1">
                          {invoice.hosted_invoice_url && (
                            <Button
                              asChild
                              variant="ghost"
                              size="compact"
                              leftIcon={
                                <ExternalLink className="h-3.5 w-3.5" />
                              }
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
                              iconOnly={<Download className="h-3.5 w-3.5" />}
                              aria-label="Download invoice PDF"
                              onClick={() => downloadPdf(invoice.invoice_pdf!)}
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(hasHiddenRows || showLoadMore || showLoadMoreError) && (
              <div className="flex flex-wrap items-center gap-4 self-start">
                {hasHiddenRows && (
                  <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    className="text-body-small-default text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-secondary)]"
                    data-testid="invoices-show-more"
                  >
                    {showAll
                      ? "Show less"
                      : `Show more (${invoices.length - INITIAL_VISIBLE} more)`}
                  </button>
                )}
                {showLoadMore && (
                  <button
                    type="button"
                    onClick={() => void invoicesQuery.fetchNextPage()}
                    disabled={invoicesQuery.isFetchingNextPage}
                    className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid="invoices-load-more"
                  >
                    {invoicesQuery.isFetchingNextPage && (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                    Load more
                  </button>
                )}
                {showLoadMoreError && (
                  <div
                    className="flex items-center gap-2"
                    data-testid="invoices-load-more-error"
                  >
                    <Typography
                      as="span"
                      variant="body-small-default"
                      className="text-[color:var(--content-negative)]"
                    >
                      Failed to load more invoices.
                    </Typography>
                    <button
                      type="button"
                      onClick={retryLoadMore}
                      disabled={invoicesQuery.isRefetching}
                      className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)] underline transition-colors hover:text-[var(--content-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                      data-testid="invoices-load-more-retry"
                    >
                      {invoicesQuery.isRefetching && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )}
                      Retry
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
