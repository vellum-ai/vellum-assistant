import { Loader2 } from "lucide-react";

/**
 * Format a USD amount string for display (e.g. "12.50" -> "$12.50").
 * Returns "$0.00" for unparseable values.
 */
function formatUsd(value: string): string {
  const num = parseFloat(value);
  if (Number.isNaN(num)) {
    return "$0.00";
  }
  return `$${num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Format an event count for display with thousands separators.
 */
function formatEventCount(count: number): string {
  return `${count.toLocaleString("en-US")} events`;
}

/**
 * Compact summary card showing total spend and event count for the selected
 * billing usage period. Displayed above the time-series chart on the usage tab.
 */
export function BillingUsageSummary({
  totalUsd,
  eventCount,
  isLoading,
}: {
  totalUsd: string | undefined;
  eventCount: number | undefined;
  isLoading: boolean;
}) {
  return (
    <div className="flex items-center gap-6 rounded-lg border border-stone-200 bg-stone-50 p-5 dark:border-moss-600 dark:bg-moss-700/50">
      <div>
        <p className="text-body-small-default text-stone-500 dark:text-stone-400">
          Total Spend
        </p>
        <p className="text-title-medium text-stone-900 dark:text-stone-100">
          {isLoading ? (
            <Loader2 className="inline h-4 w-4 animate-spin" />
          ) : totalUsd !== undefined ? (
            formatUsd(totalUsd)
          ) : (
            "\u2014"
          )}
        </p>
      </div>
      <div>
        <p className="text-body-small-default text-stone-500 dark:text-stone-400">Events</p>
        <p className="text-title-medium text-stone-900 dark:text-stone-100">
          {isLoading ? (
            <Loader2 className="inline h-4 w-4 animate-spin" />
          ) : eventCount !== undefined ? (
            formatEventCount(eventCount)
          ) : (
            "\u2014"
          )}
        </p>
      </div>
    </div>
  );
}
