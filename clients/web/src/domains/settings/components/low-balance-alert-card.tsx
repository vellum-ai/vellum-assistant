import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ChangeEvent } from "react";

import {
  organizationsBillingLowBalanceAlertRetrieveOptions,
  organizationsBillingLowBalanceAlertRetrieveQueryKey,
  organizationsBillingLowBalanceAlertRetrieveSetQueryData,
  organizationsBillingLowBalanceAlertUpdateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import { t, useTranslation } from "@/i18n";
import { formatUsd } from "@/utils/format-usd";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";

/**
 * Validate the threshold input against the same bounds the backend enforces
 * ($1..$1000, two decimal places). Exported so unit tests can exercise it
 * without rendering the card. Empty string is valid here — it means "clear
 * the override" and is sent to the API as `null`.
 */
export function validateThreshold(raw: string): string | undefined {
  if (raw.trim() === "") {
    return undefined;
  }
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 1 || n > 1000) {
    return t("settings:lowBalanceAlertCard.errorRange");
  }
  // Reject more than two decimal places (backend requires exactly two; we
  // pad on save, but can't silently round away cents the user typed).
  if (!/^\d+(\.\d{1,2})?$/.test(raw.trim())) {
    return t("settings:lowBalanceAlertCard.errorDecimals");
  }
  return undefined;
}

/**
 * Settings → Billing low-balance alert control. Embedded directly inside the
 * Credit Balance card by `BillingPanel.tsx` (under a divider, after the
 * auto-reload section). A single always-visible input sets "alert me when my
 * balance drops below $X"; clearing it (or Reset to default) reverts to the
 * global default threshold.
 */
export function LowBalanceAlertCard() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const alertQuery = useQuery(
    organizationsBillingLowBalanceAlertRetrieveOptions(),
  );
  const updateMutation = useMutation(
    organizationsBillingLowBalanceAlertUpdateMutation(),
  );

  // `undefined` means "not yet edited" — seed from the query below once it
  // loads. Tracking the edited value separately keeps the input controlled
  // without an effect that copies server state into local state.
  const [draft, setDraft] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  if (alertQuery.isLoading) {
    return (
      <div data-testid="low-balance-alert-card">
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("lowBalanceAlertCard.loading")}
        </p>
      </div>
    );
  }
  if (alertQuery.isError || !alertQuery.data) {
    return (
      <div data-testid="low-balance-alert-card">
        <Notice tone="error">{t("lowBalanceAlertCard.loadError")}</Notice>
      </div>
    );
  }

  const config = alertQuery.data;
  // `draft === null` → user hasn't edited; show the current override (or empty
  // when unset so the placeholder/default copy shows through).
  const value = draft ?? config.threshold_usd ?? "";
  const clientError = validateThreshold(value);

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    setDraft(e.target.value);
  };

  const persist = (threshold_usd: string | null) => {
    updateMutation.mutate(
      { body: { threshold_usd } },
      {
        onSuccess: (data) => {
          organizationsBillingLowBalanceAlertRetrieveSetQueryData(
            queryClient,
            undefined,
            data,
          );
          void queryClient.invalidateQueries({
            queryKey: organizationsBillingLowBalanceAlertRetrieveQueryKey(),
          });
          setDraft(null);
          setTouched(false);
        },
      },
    );
  };

  const handleSave = () => {
    setTouched(true);
    if (clientError) {
      return;
    }
    // Empty input clears the override (revert to the global default).
    const trimmed = value.trim();
    persist(trimmed === "" ? null : parseFloat(trimmed).toFixed(2));
  };

  const handleReset = () => {
    setDraft("");
    setTouched(false);
    persist(null);
  };

  const showGenericError = updateMutation.isError;
  const visibleError = touched ? clientError : undefined;

  return (
    <div data-testid="low-balance-alert-card">
      <div className="flex flex-wrap items-start gap-2">
        <div className="w-60 max-w-full">
          <Input
            type="number"
            step="0.01"
            label={t("lowBalanceAlertCard.label")}
            helperText={t("lowBalanceAlertCard.helperText", {
              amount: formatUsd(config.default_threshold_usd),
            })}
            placeholder={config.effective_threshold_usd}
            value={value}
            onChange={onChange}
            onBlur={() => setTouched(true)}
            errorText={visibleError}
            data-testid="low-balance-alert-input"
            fullWidth
          />
        </div>
        {/*
         * `pt-[20px]` centres the buttons against the input box (12px label +
         * 6px gap before the input starts), matching AutoTopUpForm's row.
         */}
        <div className="flex shrink-0 items-center gap-2 pt-[20px]">
          {config.threshold_usd != null && (
            <Button
              variant="outlined"
              onClick={handleReset}
              disabled={updateMutation.isPending}
              data-testid="low-balance-alert-reset-button"
            >
              {t("lowBalanceAlertCard.reset")}
            </Button>
          )}
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={updateMutation.isPending}
            data-testid="low-balance-alert-save-button"
          >
            {t("lowBalanceAlertCard.save")}
          </Button>
        </div>
      </div>

      {showGenericError && (
        <Notice
          tone="error"
          className="mt-4"
          data-testid="low-balance-alert-update-error"
        >
          {t("lowBalanceAlertCard.saveError")}
        </Notice>
      )}
    </div>
  );
}
