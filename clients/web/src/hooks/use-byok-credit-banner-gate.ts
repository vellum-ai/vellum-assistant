import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { organizationsBillingUsageTotalsRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import {
  configGetOptions,
  configLlmDefaultproviderGetOptions,
  conversationsByIdGetOptions,
  inferenceProfilesGetOptions,
  inferenceProviderconnectionsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  type AvailabilityStatus,
  defaultChatRouteBurnsManagedCredits,
} from "@/lib/billing/byok-credit-route";
import { useSupportsDefaultProviderSettings } from "@/lib/backwards-compat/default-provider-settings";
import { useSupportsInferenceProfiles } from "@/lib/backwards-compat/use-supports-inference-profiles";
import { awaitsAnswer } from "@/lib/query-awaits-answer";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC calendar date (YYYY-MM-DD) for an epoch-ms instant. */
function utcDateString(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * The current UTC calendar date, re-rendered when it rolls over: render-phase
 * purity forbids reading the clock inline, so the value lives in state and an
 * effect timer re-reads the clock just past each UTC midnight. Keeps the
 * spend-probe window below from freezing at its mount date in a long-lived
 * chat tab.
 */
function useUtcDay(): string {
  const [day, setDay] = useState(() => utcDateString(Date.now()));
  useEffect(() => {
    const now = Date.now();
    // The epoch is UTC-midnight-aligned, so the next rollover is the next
    // whole DAY_MS boundary; the extra second keeps a fast timer from firing
    // a hair before midnight and reading the same day again.
    const untilRollover = DAY_MS - (now % DAY_MS) + 1000;
    const timer = setTimeout(
      () => setDay(utcDateString(Date.now())),
      untilRollover,
    );
    return () => clearTimeout(timer);
  }, [day]);
  return day;
}

/**
 * The route classification, and how much of it a caller may act on.
 *
 * `suppress` holds the balance banners down. A banner treats "route unknown"
 * and "route spends the wallet" the same way, so an unresolved classification
 * folds safely into it, and only into it.
 *
 * A caller making a positive claim needs the two facts `suppress` cannot
 * carry. `settled` is false while the classification may still change.
 * `routeBurnsManaged` is true only for a route derived as managed, which a
 * fail-open null and a proven BYOK route both are not. Neither is the
 * negation of `suppress`, and reading them as one turns a missing answer into
 * an assertion.
 */
export interface ByokCreditRouteVerdict {
  suppress: boolean;
  settled: boolean;
  routeBurnsManaged: boolean;
}

/**
 * Whether the low/exhausted credit banners should stay down because the org's
 * default chat route doesn't spend managed credits and nothing else has been
 * spending them either, plus what a positive claim about that route may rest
 * on. See {@link ByokCreditRouteVerdict} for why those are separate answers.
 *
 * A BYOK default profile makes an exhausted managed balance irrelevant to
 * chat: turns dispatch on the user's own key and never fail on the platform's
 * wallet, so the credit wall would nag about credits the user isn't using.
 * Recent managed spend re-arms the banners: other surfaces (a managed profile
 * on another conversation, managed speech/search, background call-sites)
 * still burn credits, and a burn inside the last 24 hours means the balance
 * is load-bearing again. The spend probe is day-granular (usage-totals
 * `from`/`to` are inclusive UTC dates), so "last 24 hours" is
 * yesterday-plus-today, which errs toward showing the banners.
 *
 * Fails open: suppression needs a positively derived BYOK route, so a
 * managed route, an underivable one (unknown binding, no resolved assistant),
 * or a failed config/connections read all leave the banners up. The only
 * unresolved state that suppresses is the queries' initial in-flight load,
 * which keeps the banner from flashing at a BYOK user and merely delays it
 * for a managed one. All queries stay idle until `candidate` is true (a
 * banner would actually show), so the common healthy-balance path costs
 * nothing.
 *
 * @param conversationId The active conversation, when the caller has one.
 *   Its `inferenceProfile` pin outranks the global default in the daemon's
 *   resolver, so a managed pin on a BYOK-default assistant must keep the
 *   banners up; the query shares its cache entry with
 *   `useActiveProfileModel`. Client-minted drafts have no server row and
 *   must pass null (a lookup would 404 and needlessly fail the gate open).
 * @param draftProfile The composer-stashed profile of a draft conversation:
 *   the pin the first message dispatches on, standing in for the row's
 *   `inferenceProfile` until the row exists. Read only when
 *   `conversationId` is null.
 */
export function useByokCreditRouteVerdict(
  candidate: boolean,
  conversationId?: string | null,
  draftProfile?: string | null,
): ByokCreditRouteVerdict {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const routeQueriesEnabled = candidate && assistantId != null;
  const configQuery = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: routeQueriesEnabled,
    staleTime: 30_000,
  });
  const connectionsQuery = useQuery({
    ...inferenceProviderconnectionsGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: routeQueriesEnabled,
    staleTime: 30_000,
  });
  const conversationQuery = useQuery({
    ...conversationsByIdGetOptions({
      path: { assistant_id: assistantId ?? "", id: conversationId ?? "" },
    }),
    enabled: routeQueriesEnabled && conversationId != null,
  });
  // Availability is the proof side of a BYOK verdict: dispatch soft-falls
  // back to the (possibly platform-billed) default transport when a
  // credential fails at send time, so a BYOK route only counts once its
  // connection is provably dispatchable. A failed read here just leaves the
  // proof absent, which the classification treats as unknown (banners up).
  // Both endpoints are version-gated: assistants older than the gates never
  // receive the requests, the proof stays absent, and every balance banner
  // shows unsuppressed.
  const supportsInferenceProfiles = useSupportsInferenceProfiles();
  const supportsDefaultProviderStatus = useSupportsDefaultProviderSettings();
  const profilesQuery = useQuery({
    ...inferenceProfilesGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: routeQueriesEnabled && supportsInferenceProfiles,
    staleTime: 30_000,
  });
  const defaultProviderQuery = useQuery({
    ...configLlmDefaultproviderGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: routeQueriesEnabled && supportsDefaultProviderStatus,
    staleTime: 30_000,
  });

  const profileAvailability = useMemo(
    () =>
      new Map<string, AvailabilityStatus>(
        (profilesQuery.data?.profiles ?? []).flatMap((p) =>
          p.availability ? [[p.name, p.availability.status] as const] : [],
        ),
      ),
    [profilesQuery.data],
  );

  // A caller-supplied conversation may carry the highest-precedence managed
  // pin, so classifying without its row (a failed lookup, not just a missing
  // pin) would silently drop that rung; requiring the row keeps a fetch
  // error on the fail-open path below.
  const overrideKnown =
    conversationId == null || conversationQuery.data !== undefined;
  const burnsManaged =
    configQuery.data && connectionsQuery.data && overrideKnown
      ? defaultChatRouteBurnsManagedCredits({
          llm: configQuery.data.llm,
          connections: connectionsQuery.data.connections,
          profileAvailability,
          defaultProviderAvailability:
            defaultProviderQuery.data?.availability.status,
          defaultProviderResolvedConnection:
            defaultProviderQuery.data?.resolvedConnectionName,
          overrideProfile:
            conversationId != null
              ? (conversationQuery.data?.conversation.inferenceProfile ?? null)
              : (draftProfile ?? null),
        })
      : null;

  const utcDay = useUtcDay();
  const usageWindow = useMemo(
    () => ({
      // YYYY-MM-DD parses as UTC midnight, so `from` is simply the prior day.
      from: utcDateString(Date.parse(utcDay) - DAY_MS),
      to: utcDay,
    }),
    [utcDay],
  );
  const totalsQuery = useQuery({
    ...organizationsBillingUsageTotalsRetrieveOptions({
      query: usageWindow,
    }),
    enabled: candidate && burnsManaged === false,
    // Managed spend can also happen outside conversation turns (speech,
    // background call-sites in other clients), which no turn-end
    // invalidation covers, so poll while enabled. The query is only enabled
    // in the rare exhausted-or-low BYOK state, so the interval costs nothing
    // on the healthy path and bounds how long a cached zero can keep
    // suppressing after such a burn.
    refetchInterval: 5 * 60_000,
  });

  // Only a positively managed route. A null (a read missing or failed) is not
  // one, and neither is a proven BYOK route whose banners the spend probe
  // re-arms: spend on another surface says nothing about where this
  // conversation's next turn dispatches.
  const routeBurnsManaged = burnsManaged === true;

  if (!candidate) {
    return { suppress: false, settled: true, routeBurnsManaged };
  }
  // Idle and empty is "not asked yet", not "answered no": every route query
  // waits on a resolved assistant, so until one arrives the fail-open verdict
  // below rests on nothing.
  const cannotAskYet = assistantId == null;
  const routeAwaitingAnswer =
    awaitsAnswer(configQuery) ||
    awaitsAnswer(connectionsQuery) ||
    awaitsAnswer(conversationQuery) ||
    awaitsAnswer(profilesQuery) ||
    awaitsAnswer(defaultProviderQuery);
  // `isLoading` (pending AND fetching) distinguishes the initial in-flight
  // load, which suppresses to avoid a flash, from a disabled or errored
  // query, which must fail open below.
  if (
    configQuery.isLoading ||
    connectionsQuery.isLoading ||
    conversationQuery.isLoading ||
    profilesQuery.isLoading ||
    defaultProviderQuery.isLoading
  ) {
    return { suppress: true, settled: false, routeBurnsManaged };
  }
  if (burnsManaged !== false) {
    // Fail-open covers a genuine read failure as well as a missing assistant
    // or an offline gap. The first is a final answer, the others are not.
    return {
      suppress: false,
      settled: !cannotAskYet && !routeAwaitingAnswer,
      routeBurnsManaged,
    };
  }
  // Route proven BYOK: stay down only while the spend probe positively
  // reports no recent burn (or is still loading). A failed probe fails open
  // like every other unknown in this gate: a burn may have happened and the
  // banners must not stay hidden on missing data.
  if (totalsQuery.isError) {
    return { suppress: false, settled: true, routeBurnsManaged };
  }
  const totals = totalsQuery.data;
  const burnedRecently = totals ? Number(totals.total_usd) > 0 : null;
  return {
    suppress: burnedRecently !== true,
    settled:
      !cannotAskYet && !routeAwaitingAnswer && !awaitsAnswer(totalsQuery),
    routeBurnsManaged,
  };
}
