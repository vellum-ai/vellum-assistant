import {
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { useRef, useState } from "react";

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";

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
import { stripeScaleDigits } from "@vellumai/service-contracts/stripe-currency";

const EMPTY_RESPONSE: InvoiceListResponse = { invoices: [], has_more: false };

const INITIAL_VISIBLE = 4;

// The footer's text-link affordances stay muted rather than link-colored.
const FOOTER_LINK_CLASS =
  "text-body-small-default [--vbtn-fg:var(--content-tertiary)] hover:[--vbtn-fg:var(--content-secondary)]";

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

/**
 * Amounts are in Stripe's minor units; render as major units using Stripe's
 * amount scaling rules (2 for USD, 0 for JPY, 3 for BHD). The display
 * fraction digits are forced to match the same scale so Intl's ISO metadata
 * cannot round Stripe's two-decimal special cases (ISK, HUF, TWD, UGX).
 */
function formatAmount(minorUnits: number, currency: string): string {
  const code = currency.toUpperCase();
  const digits = stripeScaleDigits(code);
  try {
    const formatter = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    return formatter.format(minorUnits / 10 ** digits);
  } catch {
    // Intl.NumberFormat throws a RangeError on invalid currency codes.
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
  // Sticky error flag scoped to pagination-initiated fetches (Load more and
  // Retry). Unlike isRefetchError it ignores failed background refetches
  // (window focus, reconnect), which should stay silent: the table still
  // shows cached data and the user never asked for more.
  const [pageLoadFailed, setPageLoadFailed] = useState(false);
  // Bumped when the section toggles; a page fetch that started before the
  // bump must not write pageLoadFailed after the toggle already cleared it.
  const loadAttemptRef = useRef(0);
  const queryClient = useQueryClient();

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
  // pageLoadFailed keeps the error up through the whole retry: a plain
  // refetch clears the fetchMore meta, so isFetchNextPageError alone would
  // drop mid-retry.
  const showLoadMoreError =
    invoicesQuery.isFetchNextPageError || pageLoadFailed;
  // "Load more" renders whenever every locally loaded row is already visible
  // but the server still has more, so remaining invoices are always reachable.
  // Retry supersedes it while the inline error is up.
  const showLoadMore =
    (showAll || !hasHiddenRows) &&
    invoicesQuery.hasNextPage &&
    !showLoadMoreError;
  // A retry runs as a refetch followed by a next-page fetch; cover both
  // phases so a mid-retry click can't cancel the in-flight page fetch.
  const retryInFlight =
    invoicesQuery.isRefetching || invoicesQuery.isFetchingNextPage;

  function loadMore(): void {
    // fetchNextPage() resolves with the query result rather than rejecting,
    // so read isError from it to keep pageLoadFailed in sync.
    const attempt = loadAttemptRef.current;
    void invoicesQuery.fetchNextPage().then((result) => {
      if (attempt !== loadAttemptRef.current) {
        return;
      }
      setPageLoadFailed(result.isError);
    });
  }

  function retryLoadMore(): void {
    // refetch() recomputes every cached page's cursor, healing a stale
    // starting_after, then fetchNextPage() fetches the page the user asked
    // for (a no-op if the refreshed pages already exhaust the list).
    const attempt = loadAttemptRef.current;
    void invoicesQuery.refetch().then((result) => {
      if (attempt !== loadAttemptRef.current) {
        return;
      }
      if (result.isError) {
        setPageLoadFailed(true);
        return;
      }
      loadMore();
    });
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
              onClick={() => {
                // Collapsing abandons a failed page load; re-expanding
                // refetches, so a stale banner would sit over fresh data.
                // The bump also stops in-flight page fetches from writing
                // pageLoadFailed after this reset, and cancelling on collapse
                // keeps an abandoned page fetch from failing after re-expand
                // and resurrecting the banner via isFetchNextPageError.
                loadAttemptRef.current += 1;
                setPageLoadFailed(false);
                if (expanded) {
                  void queryClient.cancelQueries({
                    queryKey: organizationsBillingInvoicesRetrieveInfiniteQueryKey(),
                  });
                }
                setExpanded((v) => !v);
              }}
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
                  <Button
                    variant="link"
                    onClick={() => setShowAll((v) => !v)}
                    className={FOOTER_LINK_CLASS}
                    data-testid="invoices-show-more"
                  >
                    {showAll
                      ? "Show less"
                      : `Show more (${invoices.length - INITIAL_VISIBLE} more)`}
                  </Button>
                )}
                {showLoadMore && (
                  <Button
                    variant="link"
                    onClick={loadMore}
                    disabled={invoicesQuery.isFetchingNextPage}
                    leftIcon={
                      invoicesQuery.isFetchingNextPage && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )
                    }
                    className={FOOTER_LINK_CLASS}
                    data-testid="invoices-load-more"
                  >
                    Load more
                  </Button>
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
                    <Button
                      variant="link"
                      onClick={retryLoadMore}
                      disabled={retryInFlight}
                      leftIcon={
                        retryInFlight && (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        )
                      }
                      className={FOOTER_LINK_CLASS}
                      data-testid="invoices-load-more-retry"
                    >
                      Retry
                    </Button>
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
