import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ChangeEvent } from "react";

import {
    organizationsBillingDailyCreditLimitRetrieveOptions,
    organizationsBillingDailyCreditLimitRetrieveQueryKey,
    organizationsBillingDailyCreditLimitRetrieveSetQueryData,
    organizationsBillingDailyCreditLimitUpdateMutation,
    organizationsBillingSummaryRetrieveOptions,
    organizationsBillingSummaryRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";
import { Toggle } from "@vellumai/design-library/components/toggle";

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
 * clears the limit (`null`).
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
  const updateMutation = useMutation(
    organizationsBillingDailyCreditLimitUpdateMutation(),
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
        <Notice tone="error">Failed to load daily credit limit settings.</Notice>
      </div>
    );
  }

  const config = limitQuery.data;
  const hasLimit = config.daily_credit_limit_usd != null;
  const enabled = hasLimit || pendingEnable;

  const value = draft ?? (config.daily_credit_limit_usd ?? "");
  const clientError = validateDailyLimit(value);

  const summary = summaryQuery.data;
  const dailySpend = summary?.daily_spend_usd ?? config.current_day_spent_usd;
  const limitReached = summary?.daily_limit_reached === true;

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

  const showGenericError = updateMutation.isError;
  const visibleError = touched ? clientError : undefined;

  return (
    <div data-testid="daily-credit-limit-card">
      <div className="flex flex-col gap-4">
        <Toggle
          checked={enabled}
          onChange={handleToggleChange}
          // Locked while a save is in flight: toggling off during a pending
          // enable would skip the clearing PUT, then the save's onSuccess
          // would re-enable the limit against the user's last action.
          disabled={updateMutation.isPending}
          label="Set a daily credit limit"
        />

        {enabled && (
          <>
            <div className="flex flex-wrap items-start gap-3">
              <div className="w-60 max-w-full">
                <Input
                  type="number"
                  step="0.01"
                  min="1"
                  label="Stop spending Vellum credits after"
                  helperText="Per UTC day. Resets at midnight UTC."
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
                {formatUsd(dailySpend)} of {formatUsd(config.daily_credit_limit_usd)}{" "}
                spent today
              </p>
            )}

            {limitReached && (
              <Notice tone="warning" data-testid="daily-credit-limit-reached">
                Today&apos;s Vellum credit spend has reached this limit.
                Generation resumes after midnight UTC or when you raise the
                limit.
              </Notice>
            )}
          </>
        )}
      </div>

      <p className="mt-3 text-body-small-default text-[var(--content-tertiary)]">
        Applies to Vellum credit spend only. Usage billed to your own provider
        API keys isn&apos;t limited. Resets at midnight UTC.
      </p>

      {showGenericError && (
        <Notice
          tone="error"
          className="mt-4"
          data-testid="daily-credit-limit-update-error"
        >
          Failed to save daily credit limit. Please try again.
        </Notice>
      )}
    </div>
  );
}
