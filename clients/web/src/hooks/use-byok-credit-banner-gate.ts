import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { organizationsBillingUsageTotalsRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import {
  configGetOptions,
  inferenceProviderconnectionsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { defaultChatRouteBurnsManagedCredits } from "@/lib/billing/byok-credit-route";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/** UTC calendar date (YYYY-MM-DD) for an epoch-ms instant. */
function utcDateString(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Whether the low/exhausted credit banners should stay down because the org's
 * default chat route doesn't spend managed credits and nothing else has been
 * spending them either.
 *
 * A BYOK default profile makes an exhausted managed balance irrelevant to
 * chat: turns dispatch on the user's own key and never fail on the platform's
 * wallet, so the credit wall would nag about credits the user isn't using.
 * Recent managed spend re-arms the banners — other surfaces (a managed
 * profile on another conversation, managed speech/search, background
 * call-sites) still burn credits, and a burn inside the last 24 hours means
 * the balance is load-bearing again. The spend probe is day-granular
 * (usage-totals `from`/`to` are inclusive UTC dates), so "last 24 hours" is
 * yesterday-plus-today — it errs toward showing the banners.
 *
 * Suppresses while the answer is unresolved, matching the billing-status
 * philosophy that unknown state must never flash a billing surface; a managed
 * default route re-raises the banners as soon as the config and connections
 * resolve. All queries stay idle until `candidate` is true (a banner would
 * actually show), so the common healthy-balance path costs nothing.
 */
export function useSuppressCreditBannersForByok(candidate: boolean): boolean {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const routeQueriesEnabled = candidate && assistantId != null;
  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: routeQueriesEnabled,
    staleTime: 30_000,
  });
  const { data: connectionsData } = useQuery({
    ...inferenceProviderconnectionsGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: routeQueriesEnabled,
    staleTime: 30_000,
  });

  const burnsManaged =
    config && connectionsData
      ? defaultChatRouteBurnsManagedCredits(
          config.llm,
          connectionsData.connections,
        )
      : null;

  // Frozen per mount (render must stay pure, so no Date.now() here). A mount
  // that survives a UTC midnight keeps querying the at-mount window, so burns
  // after midnight go unseen until a remount — at day granularity that only
  // delays re-arming the banners, never falsely raises them.
  const [usageWindow] = useState(() => {
    const now = Date.now();
    return {
      from: utcDateString(now - 24 * 60 * 60 * 1000),
      to: utcDateString(now),
    };
  });
  const { data: totals } = useQuery({
    ...organizationsBillingUsageTotalsRetrieveOptions({
      query: usageWindow,
    }),
    enabled: candidate && burnsManaged === false,
  });

  if (!candidate) {
    return false;
  }
  if (burnsManaged === true) {
    return false;
  }
  const burnedRecently = totals ? Number(totals.total_usd) > 0 : null;
  return burnedRecently !== true;
}
