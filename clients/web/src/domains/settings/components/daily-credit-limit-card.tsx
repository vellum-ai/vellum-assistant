import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ChangeEvent } from "react";

import { ContentReveal } from "@/components/content-reveal";
import { SkeletonLines } from "@/domains/settings/components/skeleton-lines";
import { extractDrfFieldErrors } from "@/domains/settings/utils/drf-errors";
import {
  organizationsBillingDailyCreditLimitRetrieveOptions,
  organizationsBillingDailyCreditLimitRetrieveQueryKey,
  organizationsBillingDailyCreditLimitRetrieveSetQueryData,
  organizationsBillingDailyCreditLimitUpdateMutation,
  organizationsBillingSummaryRetrieveOptions,
  organizationsBillingSummaryRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import { useAutoTopUpConfigQuery } from "@/hooks/use-auto-top-up-config";
import { useResumeDailyLimit } from "@/hooks/use-daily-limit-skip";
import { useOrgHeaderReadiness } from "@/hooks/use-is-org-ready";
import { useScrollToAnchor } from "@/hooks/use-scroll-to-anchor";
import { t, useTranslation } from "@/i18n";
import { dailyResetTimePhrase } from "@/utils/daily-reset-time";
import { formatUsd } from "@/utils/format-usd";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";
import { Toggle } from "@vellumai/design-library/components/toggle";

/**
 * In-page anchor for deep links straight to this card (chat banner "Adjust
 * Limit", the platform's daily-limit email). Must match the hash in
 * `routes.settings.usageBillingDailyLimit`.
 */
export const DAILY_CREDIT_LIMIT_ANCHOR_ID = "daily-credit-limit";

/**
 * Validate the daily-limit input against the bounds the backend enforces
 * (decimal ≥ $1, two decimal places). Exported so unit tests can exercise it
 * without rendering the card. An empty string is invalid here — turning the
 * limit off is done via the toggle (which clears it to `null`), not by saving
 * a blank amount.
 */
export function validateDailyLimit(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return t("settings:dailyCreditLimitCard.errorEmpty");
  }
  const n = parseFloat(trimmed);
  if (!Number.isFinite(n) || n < 1) {
    return t("settings:dailyCreditLimitCard.errorMin");
  }
  // Reject more than two decimal places (backend requires exactly two; we pad
  // on save, but can't silently round away cents the user typed).
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return t("settings:dailyCreditLimitCard.errorDecimals");
  }
  return undefined;
}

/**
 * Whether a query still owes this render data. `isPending` alone is not
 * enough, so this reads the fetch status and counts only an in-flight request
 * as awaiting:
 *
 * - `"idle"`: a disabled observer (the auto top-up config while the org header
 *   is resolving) or a settled one, with no request on the way.
 * - `"paused"`: the browser is offline, so the request is deferred with no
 *   deadline. TanStack resumes it on reconnect, so the fallback shown now
 *   heals into content by itself.
 * - `"fetching"`: a request is genuinely in flight and this render owes the
 *   user a skeleton.
 *
 * Both non-fetching cases count as settled, and the card falls back the same
 * way it does for a failure instead of holding a skeleton with no error to
 * escape through.
 */
function isAwaitingData(query: {
  isPending: boolean;
  fetchStatus: "fetching" | "paused" | "idle";
}): boolean {
  return query.isPending && query.fetchStatus === "fetching";
}

/**
 * Settings → Billing daily credit limit control. Embedded directly inside the
 * Credit Balance card by `BillingPanel.tsx`, under its own enable toggle. When
 * on, an always-visible input caps how much Vellum credit the org can spend per
 * UTC day; the spend counter resets at midnight UTC. Turning the toggle off
 * clears the limit (`null`), except when a saved limit is holding up enabled
 * automatic top-ups: the backend requires one in that state, so the toggle
 * stays locked on.
 *
 * The editable limit comes from the daily-credit-limit endpoint; today's spend
 * for the progress readout comes from the billing summary. Saving invalidates
 * both so the summary's `daily_limit_reached`/`daily_spend_usd` stay in sync.
 */
export function DailyCreditLimitCard() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const limitQuery = useQuery(
    organizationsBillingDailyCreditLimitRetrieveOptions(),
  );
  const summaryQuery = useQuery(organizationsBillingSummaryRetrieveOptions());
  const autoTopUpQuery = useAutoTopUpConfigQuery();
  const orgReadiness = useOrgHeaderReadiness();
  const updateMutation = useMutation(
    organizationsBillingDailyCreditLimitUpdateMutation(),
  );
  const resumeMutation = useResumeDailyLimit();

  // Every one of these can add or remove a row, so the skeleton holds until
  // all three settle: revealing on the limit query alone lets the auto top-up
  // note or the reached/skipped notices land afterwards and grow the card a
  // second time. A failure counts as settled, since each has its own fallback
  // below (the summary falls back to the limit payload, auto top-up fails
  // open).
  const layoutQueriesPending =
    isAwaitingData(limitQuery) ||
    isAwaitingData(summaryQuery) ||
    isAwaitingData(autoTopUpQuery);

  // Anchor readiness is stricter than card readiness. The reveal treats a
  // disabled auto top-up query as settled, so the card can come up while the
  // org header is still resolving; the scroll is one-shot and latches, and
  // readiness flipping afterwards puts the card back into its skeleton and
  // re-reveals it taller. Waiting out `"resolving"` keeps the scroll on the
  // final height without holding the card itself.
  useScrollToAnchor(
    DAILY_CREDIT_LIMIT_ANCHOR_ID,
    !layoutQueriesPending && orgReadiness !== "resolving",
  );

  // `draft === null` means "not yet edited"; seed from the query below. Tracking
  // the edited value separately keeps the input controlled without an effect
  // that copies server state into local state.
  const [draft, setDraft] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  // Reflects the user's intent to turn the limit on before they've saved an
  // amount. `null` limit + `pendingEnable` shows the input without a value yet.
  const [pendingEnable, setPendingEnable] = useState(false);

  const loadErrorCard = (
    <div data-testid="daily-credit-limit-card">
      <Notice tone="error">{t("dailyCreditLimitCard.loadError")}</Notice>
    </div>
  );

  // A failed limit query is terminal for this card, so it skips the wait
  // above: the siblings only shape rows this render will never reach.
  if (limitQuery.isError) {
    return loadErrorCard;
  }
  if (layoutQueriesPending) {
    return (
      // Labeled: this card's queries include the org-gated auto top-up config,
      // so it routinely loads after the tab-level stack is gone and its
      // placeholder is the only loading signal a screen reader has left.
      <div data-testid="daily-credit-limit-card">
        <SkeletonLines
          lines={2}
          lineClassName="h-6"
          label={t("dailyCreditLimitCard.loadingLabel")}
        />
      </div>
    );
  }
  if (!limitQuery.data) {
    return loadErrorCard;
  }

  const config = limitQuery.data;
  const hasLimit = config.daily_credit_limit_usd != null;
  const enabled = hasLimit || pendingEnable;

  const value = draft ?? config.daily_credit_limit_usd ?? "";
  const clientError = validateDailyLimit(value);

  const summary = summaryQuery.data;
  const dailySpend = summary?.daily_spend_usd ?? config.current_day_spent_usd;
  const limitReached = summary?.daily_limit_reached === true;
  // Prefer this endpoint's own view of the skip: saving a limit writes it back
  // here synchronously, while the summary only catches up on its invalidation.
  const limitSkipped =
    config.daily_limit_snoozed === true ||
    summary?.daily_limit_snoozed === true;
  const resetPhrase = dailyResetTimePhrase();

  // The backend requires a daily limit while automatic top-ups are on, so the
  // clearing PUT is blocked here too. Fail open whenever that state is not
  // known to be current: while the config is loading, and on any query error
  // (an errored refetch keeps serving the previous value, which may describe
  // an auto top-up the user has since disabled elsewhere). The server enforces
  // the invariant on its own, so the cost of failing open is a rejected PUT.
  const requiredByAutoTopUp =
    autoTopUpQuery.data?.enabled === true && !autoTopUpQuery.isError;

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    setDraft(e.target.value);
  };

  const persist = (dailyCreditLimitUsd: string | null) => {
    updateMutation.mutate(
      { body: { daily_credit_limit_usd: dailyCreditLimitUsd } },
      {
        onSuccess: (data) => {
          organizationsBillingDailyCreditLimitRetrieveSetQueryData(
            queryClient,
            undefined,
            data,
          );
          void queryClient.invalidateQueries({
            queryKey: organizationsBillingDailyCreditLimitRetrieveQueryKey(),
          });
          // The summary carries the derived `daily_limit_reached` /
          // `daily_credit_limit_usd` fields the chat banner and this readout
          // depend on, so refresh it too.
          void queryClient.invalidateQueries({
            queryKey: organizationsBillingSummaryRetrieveQueryKey(),
          });
          setDraft(null);
          setTouched(false);
          if (dailyCreditLimitUsd === null) {
            setPendingEnable(false);
          }
        },
      },
    );
  };

  const handleToggleChange = (next: boolean) => {
    if (next) {
      setPendingEnable(true);
      return;
    }
    // Only a saved limit is protected by the auto top-up dependency. An
    // unsaved `pendingEnable` has nothing for the backend to keep, so the user
    // can still take it back.
    if (hasLimit && requiredByAutoTopUp) {
      return;
    }
    // Turning off: clear a saved limit; if it was only pending (never saved),
    // just drop the intent without hitting the API.
    setPendingEnable(false);
    setDraft(null);
    setTouched(false);
    if (hasLimit) {
      persist(null);
    }
  };

  const handleSave = () => {
    setTouched(true);
    if (clientError) {
      return;
    }
    persist(parseFloat(value.trim()).toFixed(2));
  };

  // A rejected clear comes back as a DRF field error explaining the auto
  // top-up dependency; show it verbatim instead of the generic copy.
  const serverLimitError = extractDrfFieldErrors(
    updateMutation.error,
  ).daily_credit_limit_usd;
  const saveError =
    serverLimitError ??
    (updateMutation.isError ? t("dailyCreditLimitCard.saveError") : undefined);
  const visibleError = touched ? clientError : undefined;

  return (
    <ContentReveal>
      <div data-testid="daily-credit-limit-card">
        <div className="flex flex-col gap-4">
          <Toggle
            checked={enabled}
            onChange={handleToggleChange}
            // Locked while a save is in flight: toggling off during a pending
            // enable would skip the clearing PUT, then the save's onSuccess
            // would re-enable the limit against the user's last action. Also
            // locked once a saved limit is what automatic top-ups depend on,
            // where the only available move is the one the backend rejects.
            disabled={
              updateMutation.isPending || (hasLimit && requiredByAutoTopUp)
            }
            label={t("dailyCreditLimitCard.toggleLabel")}
            helperText={
              enabled ? t("dailyCreditLimitCard.toggleSubtitle") : undefined
            }
          />

          {requiredByAutoTopUp && (
            <p
              className="text-body-small-default text-[var(--content-tertiary)]"
              data-testid="daily-credit-limit-required-note"
            >
              {t("dailyCreditLimitCard.requiredNote")}
            </p>
          )}

          {enabled && (
            <>
              <div className="flex flex-wrap items-start gap-2">
                <div className="w-60 max-w-full">
                  <Input
                    type="number"
                    step="0.01"
                    min="1"
                    label={t("dailyCreditLimitCard.inputLabel")}
                    helperText={t("dailyCreditLimitCard.helperText", {
                      time: resetPhrase,
                    })}
                    placeholder="0.00"
                    value={value}
                    onChange={onChange}
                    onBlur={() => setTouched(true)}
                    errorText={visibleError}
                    data-testid="daily-credit-limit-input"
                    fullWidth
                  />
                </div>
                {/*
                 * `pt-[20px]` centres the button against the input box (12px label +
                 * 6px gap before the input starts), matching the sibling cards.
                 */}
                <div className="flex shrink-0 items-center gap-2 pt-[20px]">
                  <Button
                    variant="primary"
                    onClick={handleSave}
                    disabled={updateMutation.isPending}
                    data-testid="daily-credit-limit-save-button"
                  >
                    {t("dailyCreditLimitCard.save")}
                  </Button>
                </div>
              </div>

              {hasLimit && config.daily_credit_limit_usd != null && (
                <p
                  className="text-body-small-default text-[var(--content-tertiary)]"
                  data-testid="daily-credit-limit-progress"
                >
                  {t("dailyCreditLimitCard.progress", {
                    spent: formatUsd(dailySpend),
                    limit: formatUsd(config.daily_credit_limit_usd),
                  })}
                </p>
              )}

              {limitSkipped && (
                <>
                  <Notice
                    tone="info"
                    data-testid="daily-credit-limit-skipped"
                    actions={
                      <Button
                        variant="outlined"
                        size="compact"
                        onClick={() => resumeMutation.mutate({})}
                        disabled={resumeMutation.isPending}
                        data-testid="daily-credit-limit-resume-button"
                      >
                        {t("dailyCreditLimitCard.resumeNow")}
                      </Button>
                    }
                  >
                    {t("dailyCreditLimitCard.skippedNotice", {
                      time: resetPhrase,
                    })}
                  </Notice>
                  {resumeMutation.isError && (
                    <Notice
                      tone="error"
                      data-testid="daily-credit-limit-resume-error"
                    >
                      {t("dailyCreditLimitCard.resumeError")}
                    </Notice>
                  )}
                </>
              )}

              {limitReached && (
                <Notice tone="warning" data-testid="daily-credit-limit-reached">
                  {t("dailyCreditLimitCard.reachedNotice", {
                    time: resetPhrase,
                  })}
                </Notice>
              )}
            </>
          )}
        </div>

        {saveError != null && (
          <Notice
            tone="error"
            className="mt-4"
            data-testid="daily-credit-limit-update-error"
          >
            {saveError}
          </Notice>
        )}
      </div>
    </ContentReveal>
  );
}
