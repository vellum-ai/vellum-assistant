/**
 * At-a-glance memory cost line for the Memory card on the Advanced settings
 * page. Sums the last 30 days of LLM spend across call sites in the "memory"
 * domain so users can see what having memory enabled costs, right next to the
 * toggle that turns it off. Links to the usage page for the full breakdown.
 *
 * Talks to the generated daemon query factories directly (not `domains/logs`
 * fetch wrappers) to respect the no-cross-domain-imports rule.
 */

import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router";

import {
  formatMemoryCostUsd,
  sumMemoryCallSiteCostUsd,
} from "@/domains/settings/components/memory-cost";
import {
  configLlmCallsitesGetOptions,
  usageBreakdownGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { routes } from "@/utils/routes";
import { resolveUsageRangeWindow } from "@/utils/usage-window";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";

export function MemoryCostSummary({ assistantId }: { assistantId: string }) {
  const timezone = useEffectiveTimezone();
  const rangeWindow = useMemo(
    () => resolveUsageRangeWindow("30d", timezone),
    [timezone],
  );

  const catalogQuery = useQuery({
    ...configLlmCallsitesGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: Infinity,
    retry: 1,
  });

  const breakdownQuery = useQuery({
    ...usageBreakdownGetOptions({
      path: { assistant_id: assistantId },
      query: {
        from: rangeWindow.from,
        to: rangeWindow.to,
        groupBy: "call_site",
      },
    }),
    staleTime: 60_000,
    retry: 1,
  });

  const memoryCostUsd = useMemo(() => {
    if (!catalogQuery.data || !breakdownQuery.data) {
      return null;
    }
    return sumMemoryCallSiteCostUsd(
      breakdownQuery.data.breakdown,
      catalogQuery.data.callSites,
    );
  }, [catalogQuery.data, breakdownQuery.data]);

  // Older daemons may not support the per-call-site breakdown; the toggle
  // works without the cost line, so degrade by hiding it.
  if (catalogQuery.isError || breakdownQuery.isError) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-body-medium-default text-[var(--content-secondary)]">
          Cost in the last 30 days
        </span>
        <span className="text-body-medium-default tabular-nums text-[var(--content-emphasised)]">
          {memoryCostUsd == null ? "—" : formatMemoryCostUsd(memoryCostUsd)}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
          Includes the background work your assistant does to save and look up
          memories.
        </span>
        <Link
          to={routes.logs.usageByAction("30d")}
          className="inline-flex shrink-0 items-center gap-1 text-body-medium-lighter text-[var(--system-positive-strong)] underline hover:opacity-80"
        >
          View usage
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}
