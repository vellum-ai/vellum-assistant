import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ChangeEvent } from "react";

import { extractDrfFieldErrors } from "@/domains/settings/utils/drf-errors";
import {
  organizationsBillingAutoTopUpRetrieveOptions,
  organizationsBillingDailyCreditLimitRetrieveOptions,
  organizationsBillingDailyCreditLimitRetrieveQueryKey,
  organizationsBillingDailyCreditLimitRetrieveSetQueryData,
  organizationsBillingDailyCreditLimitUpdateMutation,
  organizationsBillingSummaryRetrieveOptions,
  organizationsBillingSummaryRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import { useScrollToAnchor } from "@/hooks/use-scroll-to-anchor";
import { dailyResetTimePhrase } from "@/utils/daily-reset-time";
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

/** Format a USD decimal string ("5.00") as "$5.00" for display copy. */
function formatUsd(value: string): string {
  const n = parseFloat(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : `$${value}`;
}

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
    return "Enter a daily limit";
  }
  const n = parseFloat(trimmed);
  if (!Number.isFinite(n) || n < 1) {
    return "Must be at least $1";
  }
  // Reject more than two decimal places (backend requires exactly two; we pad
  // on save, but can't silently round away cents the user typed).
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return "Use at most two decimal places";
  }
  return undefined;
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
  const queryClient = useQueryClient();
  const limitQuery = useQuery(
    organizationsBillingDailyCreditLimitRetrieveOptions(),
  );
  const summaryQuery = useQuery(organizationsBillingSummaryRetrieveOptions());
  const autoTopUpQuery = useQuery(
    organizationsBillingAutoTopUpRetrieveOptions(),
  );
  const updateMutation = useMutation(
    organizationsBillingDailyCreditLimitUpdateMutation(),
  );

  // Deep links (`#daily-credit-limit`) land here once both queries have
  // settled, so the content above the anchor has taken its final height
  // before we scroll.
  useScrollToAnchor(
    DAILY_CREDIT_LIMIT_ANCHOR_ID,
    !limitQuery.isLoading && !summaryQuery.isLoading,
  );

  // `draft === null` means "not yet edited"; seed from the query below. Tracking
  // the edited value separately keeps the input controlled without an effect
  // that copies server state into local state.
  const [draft, setDraft] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  // Reflects the user's intent to turn the limit on before they've saved an
  // amount. `null` limit + `pendingEnable` shows the input without a value yet.
  const [pendingEnable, setPendingEnable] = useState(false);

  if (limitQuery.isLoading) {
    return (
      <div data-testid="daily-credit-limit-card">
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          Loading…
        </p>
      </div>
    );
  }
  if (limitQuery.isError || !limitQuery.data) {
    return (
      <div data-testid="daily-credit-limit-card">
        <Notice tone="error">
          Failed to load daily credit limit settings.
        </Notice>
      </div>
    );
  }

  const config = limitQuery.data;
  const hasLimit = config.daily_credit_limit_usd != null;
  const enabled = hasLimit || pendingEnable;

  const value = draft ?? config.daily_credit_limit_usd ?? "";
  const clientError = validateDailyLimit(value);

  const summary = summaryQuery.data;
  const dailySpend = summary?.daily_spend_usd ?? config.current_day_spent_usd;
  const limitReached = summary?.daily_limit_reached === true;
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
  const serverLimitError =
    extractDrfFieldErrors(updateMutation.error).daily_credit_limit_usd;
  const saveError =
    serverLimitError ??
    (updateMutation.isError
      ? "Failed to save daily credit limit. Please try again."
      : undefined);
  const visibleError = touched ? clientError : undefined;

  return (
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
          label="Set a daily credit limit"
        />

        {requiredByAutoTopUp && (
          <p
            className="text-body-small-default text-[var(--content-tertiary)]"
            data-testid="daily-credit-limit-required-note"
          >
            A daily credit limit is required while automatic top-ups are
            enabled.
          </p>
        )}

        {enabled && (
          <>
            <div className="flex flex-wrap items-start gap-3">
              <div className="w-60 max-w-full">
                <Input
                  type="number"
                  step="0.01"
                  min="1"
                  label="Stop spending Vellum credits after"
                  helperText={`Resets daily at ${resetPhrase}.`}
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
               * `pt-[18px]` aligns the button with the input box (12px label +
               * 6px gap before the input starts), matching the sibling cards.
               */}
              <div className="flex shrink-0 items-center gap-2 pt-[18px]">
                <Button
                  variant="primary"
                  onClick={handleSave}
                  disabled={updateMutation.isPending}
                  data-testid="daily-credit-limit-save-button"
                >
                  Save
                </Button>
              </div>
            </div>

            {hasLimit && config.daily_credit_limit_usd != null && (
              <p
                className="text-body-small-default text-[var(--content-tertiary)]"
                data-testid="daily-credit-limit-progress"
              >
                {formatUsd(dailySpend)} of{" "}
                {formatUsd(config.daily_credit_limit_usd)} spent today
              </p>
            )}

            {limitReached && (
              <Notice tone="warning" data-testid="daily-credit-limit-reached">
                Today&apos;s Vellum credit spend has reached this limit.
                Generation resumes at {resetPhrase} or when you raise the
                limit.
              </Notice>
            )}
          </>
        )}
      </div>

      <p className="mt-3 text-body-small-default text-[var(--content-tertiary)]">
        Applies to Vellum credit spend only. Usage billed to your own provider
        API keys isn&apos;t limited. Resets daily at {resetPhrase}.
      </p>

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
  );
}
