import { Coins, Info, X } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";

import {
  organizationsBillingAutoTopUpDisableCreateMutation,
  organizationsBillingAutoTopUpRetrieveQueryKey,
  organizationsBillingAutoTopUpRetrieveSetQueryData,
  organizationsBillingAutoTopUpUpdateMutation,
  organizationsBillingDailyCreditLimitRetrieveQueryKey,
  organizationsBillingSummaryRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";
import { Toggle } from "@vellumai/design-library/components/toggle";
import { Typography } from "@vellumai/design-library/components/typography";

import { formatUsdShort } from "@/utils/format-usd";
import { AutoTopUpDisableConfirm } from "@/domains/settings/components/auto-top-up-disable-confirm";
import {
  AutoTopUpForm,
  type AutoTopUpFormValues,
} from "@/domains/settings/components/auto-top-up-form";
import { AutoTopUpPaymentMethodModal } from "@/domains/settings/components/auto-top-up-payment-method-modal";
import { usePaymentMethodSavedSync } from "@/domains/settings/hooks/use-payment-method-saved-poll";
import { useAutoTopUpConfigQuery } from "@/hooks/use-auto-top-up-config";
import { extractDrfFieldErrors } from "@/domains/settings/utils/drf-errors";
import { useTranslation } from "@/i18n";
import { openBillingPathInBrowser } from "@/lib/billing/android-billing-handoff";
import { useIsNativeAndroid } from "@/runtime/platform-detection";
import { routes } from "@/utils/routes";

type Mode = "view" | "form";

/** Convert API-format decimal string (e.g. "25.00") to integer string ("25") for form display. */
function apiToIntStr(v: string | null | undefined): string {
  if (!v) {
    return "";
  }
  const n = parseFloat(v);
  return Number.isFinite(n) ? String(Math.trunc(n)) : "";
}

/**
 * Local "fresh disabled" config that mirrors the payload Django's
 * `_serialize_config(None)` returns when no `AutoTopUpConfig` row exists
 * (see `django/app/billing/auto_top_up_views.py`).
 *
 * Used to seed the GET cache after a successful disable so the user sees
 * the disabled CTA immediately without waiting on a refetch.
 */
export const DISABLED_CONFIG: AutoTopUpConfigResponse = {
  enabled: false,
  threshold_usd: null,
  amount_usd: null,
  monthly_cap_usd: null,
  has_payment_method: false,
  payment_method_brand: null,
  payment_method_last4: null,
  stripe_payment_method_updated_at: null,
  last_charge_at: null,
  last_failure_at: null,
  last_failure_reason: null,
  disabled_due_to_repeated_failures: false,
  paused_until: null,
  current_month_credits_purchased_usd: "0.00",
  current_month_charged_usd: "0.00",
  next_trigger_amount_usd: null,
  stubbed: false,
};

/**
 * Neutral pill shared by the enabled-state summary row — the "add $X under
 * $Y" chip and the monthly-cap progress chip use identical chrome so they
 * read as one control group.
 */
function SummaryChip({
  testId,
  children,
}: {
  testId: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-[var(--surface-base)] px-2"
    >
      {children}
    </div>
  );
}

/**
 * Settings → Billing auto-reload rows. Embedded directly inside the Credits
 * card by `BillingPanel.tsx` (no outer Card wrapper of its own). Toggle
 * controls enable/disable; Adjust enters configure mode. Card management
 * lives in `PaymentMethodsCard`, but this card still owns saving a card (via
 * `AutoTopUpPaymentMethodModal`) for the no-PM gate below.
 *
 * - Off: just the toggle.
 * - On + no payment method: toggle + an amber "connect a credit card" banner
 *   and an "Add a Credit Card" button that opens the Stripe setup modal;
 *   saving a card advances straight into the form.
 * - On + view: toggle + inline summary ("Add $X when balance falls under
 *   $Y") + spend-vs-cap when a monthly cap is set + Adjust button.
 * - On + configuring (mode === "form"): toggle + 3-input row (threshold,
 *   amount, monthly cap) + Save.
 */
export function AutoTopUpCard() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const configQuery = useAutoTopUpConfigQuery();
  const updateMutation = useMutation(
    organizationsBillingAutoTopUpUpdateMutation(),
  );
  const disableMutation = useMutation(
    organizationsBillingAutoTopUpDisableCreateMutation(),
  );
  const syncPaymentMethodSaved = usePaymentMethodSavedSync();
  // Native Android configures auto-reload on the web app's billing page in
  // the browser; the deep link below reopens this same configurator there.
  const isNativeAndroid = useIsNativeAndroid();

  const [searchParams, setSearchParams] = useSearchParams();
  const cardRef = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<Mode>("view");
  const [pendingEnable, setPendingEnable] = useState(false);
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [showAddPm, setShowAddPm] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [pmModalOpen, setPmModalOpen] = useState(false);

  // Removing the card (in `PaymentMethodsCard`) disables auto-reload
  // server-side, so when the shared config's PM goes away, leave the add-card
  // gate and the Adjust form to keep the OFF toggle and a saveable form from
  // coexisting. Transition-gated so the poll-timeout path (`false → false`)
  // can't misfire.
  const hadPaymentMethodRef = useRef(false);
  const hasPaymentMethod = configQuery.data?.has_payment_method === true;
  useEffect(() => {
    if (hadPaymentMethodRef.current && !hasPaymentMethod) {
      setShowAddPm(false);
      setMode("view");
      setPendingEnable(false);
    }
    hadPaymentMethodRef.current = hasPaymentMethod;
  }, [hasPaymentMethod]);

  /**
   * Transition into form mode. Resets any prior mutation errors so stale
   * field-level errors (from `updateMutation`) or the disable-failure
   * banner (from `disableMutation`) don't render the moment the form
   * re-mounts (e.g. after Cancel + re-Edit, or after a failed Disable).
   * Hoisted above the loading/error guards so the deeplink effect below can
   * reuse it; depends only on the mutations and `setMode`, all bound above.
   */
  const enterFormMode = () => {
    if (isNativeAndroid) {
      openBillingPathInBrowser(routes.settings.usageBillingConfigureTopUps);
      return;
    }
    updateMutation.reset();
    disableMutation.reset();
    setMode("form");
  };

  /**
   * Shared "turn auto-reload on from disabled" flow, used by both the toggle
   * (`handleToggleChange`) and the `?configure_top_up=1` deeplink effect: with
   * no usable PM (none on file, or auto-reload paused after repeated declines)
   * reveal the add-card gate, otherwise open the configure form. Never persists
   * — Save still does. Both callers run it only while disabled, so
   * `disabled_due_to_repeated_failures` alone matches `disabledAfterDeclines`.
   */
  const beginEnableFlow = (cfg: AutoTopUpConfigResponse) => {
    if (isNativeAndroid) {
      openBillingPathInBrowser(routes.settings.usageBillingConfigureTopUps);
      return;
    }
    setPendingEnable(true);
    if (
      !cfg.has_payment_method ||
      cfg.disabled_due_to_repeated_failures === true
    ) {
      setShowAddPm(true);
      setBannerDismissed(false);
      return;
    }
    setShowAddPm(false);
    enterFormMode();
  };

  // Auto-dismiss the no-PM gate once a USABLE PM appears (saved via this
  // card's modal below, via the Payment Methods section, or discovered by a
  // background refetch). When the enable flow is still pending and the server
  // config is still disabled, continue into the configure form: without this,
  // a card saved from the other section would strand an on-looking toggle
  // with no form and no persisted enable. "Usable" excludes the
  // repeated-declines cutoff, where the declined card is still on file but
  // re-enabling with it must stay gated; the backend clears the flag once a
  // fresh PM is attached, and that transition is what fires this. Declared
  // before the early-return branches to satisfy rules-of-hooks; reads through
  // `configQuery.data` since `config` isn't bound until after the
  // loading/error guards below.
  const gateHasPaymentMethod = configQuery.data?.has_payment_method === true;
  const gateEnabled = configQuery.data?.enabled === true;
  const gateCutOff =
    configQuery.data?.disabled_due_to_repeated_failures === true;
  useEffect(() => {
    if (showAddPm && gateHasPaymentMethod && !gateCutOff) {
      setShowAddPm(false);
      if (pendingEnable && !gateEnabled) {
        enterFormMode();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `enterFormMode` is recreated per render; the guards above make re-runs no-ops
  }, [showAddPm, pendingEnable, gateHasPaymentMethod, gateEnabled, gateCutOff]);

  // Arriving with `?configure_top_up=1` (deeplinked from the Add Credits
  // modal and from the Android browser handoff) opens the configurator once,
  // then strips the param: the toggle-on path while disabled, the Adjust
  // editor while enabled. It never disables and never mutates the server;
  // persistence still requires Save. Must sit before the loading/error
  // guards below (rules-of-hooks), so it reads through `configQuery.data`
  // and reuses the shared flows rather than the post-guard
  // `config`/handlers.
  const configureTopUpRequested = searchParams.get("configure_top_up") === "1";
  useEffect(() => {
    if (!configureTopUpRequested || configQuery.data == null) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete("configure_top_up");
    setSearchParams(next, { replace: true });
    const cfg = configQuery.data;
    if (cfg.enabled === true) {
      enterFormMode();
    } else {
      beginEnableFlow(cfg);
    }
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    cardRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "center",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per arrival; `enterFormMode`/`beginEnableFlow`/`searchParams` intentionally excluded
  }, [configureTopUpRequested, configQuery.data]);

  // `isPending` rather than `isLoading`: the query idles with no data until
  // the org store is ready, and that gap must read as loading, not as the
  // error state below.
  if (configQuery.isPending) {
    return (
      <div data-testid="auto-top-up-card">
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("autoTopUpCard.loading")}
        </p>
      </div>
    );
  }
  if (configQuery.isError || !configQuery.data) {
    return (
      <div data-testid="auto-top-up-card">
        <Notice tone="error">{t("autoTopUpCard.loadError")}</Notice>
      </div>
    );
  }

  const config = configQuery.data;
  const enabled = config.enabled === true;
  // The backend pauses auto-reload after several declined charges and flips
  // this flag (it's reset once a fresh PM is attached). When set, the card
  // shows a tailored explanation instead of the generic add-PM gate copy.
  //
  // Guard on `!enabled` as well: the backend treats the cutoff as terminal
  // (cutoff ⇒ enabled=false), but if a stale/raced response ever carried both
  // `enabled: true` and the flag, we'd otherwise render the enabled summary
  // ("Add $X when balance falls under $Y") next to the "we paused reloads"
  // notice — contradictory copy. Folding `!enabled` in keeps the enabled
  // summary and the cutoff notice mutually exclusive. The enable gate in
  // `handleToggleChange` still trips correctly because that path only runs
  // while the config is currently disabled (`if (next && !enabled)`).
  const disabledAfterDeclines =
    config.disabled_due_to_repeated_failures === true && !enabled;

  const exitFormMode = () => {
    setMode("view");
    setPendingEnable(false);
  };

  /**
   * Dismiss the disable-confirm dialog. Also clears any prior
   * `disableMutation` error so the user doesn't see a stale failure
   * banner persist after they've decided not to retry.
   */
  const dismissDisableConfirm = () => {
    disableMutation.reset();
    setConfirmingDisable(false);
  };

  const handleSave = (values: AutoTopUpFormValues) => {
    // `monthly_cap_usd` is optional on the API: empty string in the form
    // means "no cap / uncapped" and is sent as `null`. The backend
    // serializer accepts null and the response renders "No limit". The
    // Hey-API request type is `string | null` for this field.
    updateMutation.mutate(
      {
        body: {
          enabled: true,
          threshold_usd: values.threshold_usd,
          amount_usd: values.amount_usd,
          monthly_cap_usd:
            values.monthly_cap_usd === "" ? null : values.monthly_cap_usd,
        },
      },
      {
        // Seed the GET cache synchronously from the PUT response so the
        // next render (after `setMode("view")`) sees the post-save state
        // immediately. A fire-and-forget `invalidateQueries` alone would
        // schedule a refetch but leave `configQuery.data` pointing at the
        // pre-save value (e.g. `enabled: false` on first-time setup) —
        // the user would briefly see the disabled CTA flash before the
        // refetch lands.
        //
        // The PUT response intentionally skips the Stripe PM retrieve to
        // avoid a ~100-300ms latency tax per save, so its
        // `payment_method_brand` / `payment_method_last4` come back null.
        // Merge with the prior cache value to preserve those fields (a
        // config edit doesn't change the PM), then invalidate to refresh
        // brand/last4 from GET in the background — that keeps them in
        // sync if the user just changed cards.
        onSuccess: (data) => {
          organizationsBillingAutoTopUpRetrieveSetQueryData(
            queryClient,
            undefined,
            (prior) => ({
              ...data,
              payment_method_brand: prior?.payment_method_brand ?? null,
              payment_method_last4: prior?.payment_method_last4 ?? null,
            }),
          );
          void queryClient.invalidateQueries({
            queryKey: organizationsBillingAutoTopUpRetrieveQueryKey(),
          });
          if (!enabled) {
            // Turning auto top-up on makes the backend apply its default daily
            // credit limit when the org has none, so refresh the daily-limit
            // card and the summary that carries the derived limit fields.
            void queryClient.invalidateQueries({
              queryKey: organizationsBillingDailyCreditLimitRetrieveQueryKey(),
            });
            void queryClient.invalidateQueries({
              queryKey: organizationsBillingSummaryRetrieveQueryKey(),
            });
          }
          exitFormMode();
        },
      },
    );
  };

  const handleConfirmDisable = () => {
    disableMutation.mutate(
      {},
      {
        // The disable response only echoes `{enabled, stubbed, message}`,
        // so write `DISABLED_CONFIG` into the GET cache to land the user on
        // the disabled CTA without an extra refetch.
        //
        // CRITICAL: the disable endpoint preserves
        // `stripe_payment_method_id` (it only flips `enabled=False`), so
        // the cache must reflect that — otherwise this card would
        // incorrectly render "No payment method on file" the moment the
        // user clicks Disable. Merge `DISABLED_CONFIG` with the prior
        // cached PM fields so the card stays accurate until the next GET
        // refresh.
        onSuccess: () => {
          organizationsBillingAutoTopUpRetrieveSetQueryData(
            queryClient,
            undefined,
            (prior) => ({
              ...DISABLED_CONFIG,
              has_payment_method: prior?.has_payment_method ?? false,
              payment_method_brand: prior?.payment_method_brand ?? null,
              payment_method_last4: prior?.payment_method_last4 ?? null,
              // Preserve the SetupIntent staleness marker. The disable
              // endpoint flips `enabled=False` but does NOT clear
              // `stripe_payment_method_id` or its updated_at marker — so
              // dropping the marker here would corrupt the polling snapshot
              // in `usePaymentMethodSavedPoll`: it reads `priorMarker` from
              // this same cache, then polls until the backend's marker
              // advances past it. If we seed `null` after disable, the next
              // "Add a Credit Card" click takes a priorMarker=null
              // snapshot, the first poll reads the backend's still-set
              // timestamp, and the poll exits immediately with stale data.
              // Carry forward the prior marker so the snapshot matches
              // backend reality.
              stripe_payment_method_updated_at:
                prior?.stripe_payment_method_updated_at ?? null,
            }),
          );
          setConfirmingDisable(false);
          setMode("view");
          setPendingEnable(false);
        },
      },
    );
  };

  /**
   * Click handler for the "Enable auto-reload" toggle. The toggle itself is
   * never disabled — turning it on always flips visually to reflect intent
   * (`pendingEnable`), even when a payment method still needs to be added.
   *
   * - Toggle on while disabled, no usable PM (missing, or cut off after
   *   repeated declines) → flip on and gate on the "Add a Credit Card"
   *   button instead of entering the form. In the cutoff case the saved
   *   card is still attached (`has_payment_method: true`), so gating here
   *   stops the user from re-enabling with the SAME declined card — they
   *   must add a new one.
   * - Toggle on while disabled, with a usable PM → enter form mode directly.
   *   The save endpoint actually flips the enabled bit; cancel reverts to
   *   disabled.
   * - Toggle off while a pending enable is in flight → cancel out of the
   *   form/gate so the toggle visibly snaps back to off without making the
   *   user hunt for the form's Cancel button.
   * - Toggle off while enabled → trigger the disable-confirm dialog. The
   *   disable endpoint flips it on confirm; otherwise we leave state alone.
   */
  const handleToggleChange = (next: boolean) => {
    if (next && !enabled) {
      beginEnableFlow(config);
      return;
    }
    if (!next && !enabled && pendingEnable) {
      setShowAddPm(false);
      exitFormMode();
      return;
    }
    if (!next && enabled) {
      setConfirmingDisable(true);
    }
  };

  /**
   * Called after `AutoTopUpPaymentMethodModal` confirms a card was saved.
   * Once the config reflects the fresh PM, drop the no-PM gate and, if the
   * user got here via the toggle, advance straight into the configure form.
   * The gate effect above may already have run off the seeded cache; both
   * paths land on the same state.
   */
  const handlePmSaved = async (args: { setupIntentId: string | null }) => {
    await syncPaymentMethodSaved(args);
    setShowAddPm(false);
    if (pendingEnable) {
      enterFormMode();
    }
  };

  const isFormMode = mode === "form";
  const fieldErrors = extractDrfFieldErrors(updateMutation.error);
  // Surface a generic notice when the mutation failed but no field-level
  // DRF errors were parsed (network failure, 5xx, non-DRF body, etc.).
  // Without this, a failed Save can otherwise look like a silent no-op.
  const showGenericUpdateError =
    updateMutation.isError && Object.keys(fieldErrors).length === 0;

  const toggleChecked = enabled || pendingEnable;

  return (
    <div ref={cardRef} data-testid="auto-top-up-card">
      <div className="flex items-center justify-between gap-4">
        <Toggle
          checked={toggleChecked}
          onChange={handleToggleChange}
          label={t("autoTopUpCard.toggleLabel")}
          helperText={
            toggleChecked ? t("autoTopUpCard.toggleHelper") : undefined
          }
        />
      </div>

      {enabled && !isFormMode && (
        <div className="mt-3 flex w-full items-center gap-2">
          <SummaryChip testId="auto-top-up-summary">
            <Coins
              className="h-3.5 w-3.5 shrink-0 text-[var(--content-default)]"
              aria-hidden="true"
            />
            <Typography
              variant="body-medium-default"
              className="truncate text-[var(--content-default)]"
            >
              {t("autoTopUpCard.summary", {
                amount: formatUsdShort(config.amount_usd),
                threshold: formatUsdShort(config.threshold_usd),
              })}
            </Typography>
          </SummaryChip>
          {config.monthly_cap_usd != null && (
            <SummaryChip testId="auto-top-up-cap-progress">
              <Typography
                variant="body-medium-default"
                className="truncate text-[var(--content-default)]"
              >
                <span>
                  {formatUsdShort(config.current_month_credits_purchased_usd)}
                </span>
                <span className="text-[var(--content-tertiary)]">
                  {t("autoTopUpCard.capProgress", {
                    cap: formatUsdShort(config.monthly_cap_usd),
                  })}
                </span>
              </Typography>
            </SummaryChip>
          )}
          <Button
            variant="outlined"
            onClick={enterFormMode}
            data-testid="auto-top-up-edit-button"
            className="shrink-0"
          >
            {t("autoTopUpCard.adjust")}
          </Button>
        </div>
      )}

      {disabledAfterDeclines && (
        <Notice
          tone="warning"
          className="mt-3"
          data-testid="auto-top-up-declined-cutoff"
          actions={
            <Button
              variant="outlined"
              onClick={() => setPmModalOpen(true)}
              data-testid="auto-top-up-add-pm-button"
            >
              {t("autoTopUpCard.addPaymentMethod")}
            </Button>
          }
        >
          {t("autoTopUpCard.declinedCutoffNotice")}
        </Notice>
      )}

      <div
        className="grid transition-[grid-template-rows] duration-200 ease-in-out"
        style={{
          gridTemplateRows: showAddPm && !disabledAfterDeclines ? "1fr" : "0fr",
        }}
      >
        <div className="overflow-hidden">
          <div className="mt-3 flex flex-col gap-3">
            {!bannerDismissed && (
              <div className="flex h-8 items-center justify-between gap-3 rounded-lg bg-[var(--system-mid-weak)] px-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Info
                    className="h-4 w-4 shrink-0 text-[var(--system-mid-strong)]"
                    aria-hidden="true"
                  />
                  <Typography
                    variant="body-medium-default"
                    className="truncate text-[var(--system-mid-strong)]"
                  >
                    {t("autoTopUpCard.connectCardBanner")}
                  </Typography>
                </div>
                <button
                  type="button"
                  aria-label={t("autoTopUpCard.dismiss")}
                  onClick={() => setBannerDismissed(true)}
                  className="flex shrink-0 cursor-pointer items-center justify-center rounded p-0.5 text-[var(--system-mid-strong)] opacity-70 transition-opacity hover:opacity-100"
                >
                  <X
                    className="h-2.5 w-2.5"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                </button>
              </div>
            )}
            <Button
              variant="primary"
              onClick={() => setPmModalOpen(true)}
              data-testid="auto-top-up-add-pm-button"
              className="self-start"
            >
              {t("autoTopUpCard.addCreditCard")}
            </Button>
          </div>
        </div>
      </div>

      {showGenericUpdateError && (
        <Notice
          tone="error"
          className="mt-4"
          data-testid="auto-top-up-update-error"
        >
          {t("autoTopUpCard.updateError")}
        </Notice>
      )}

      {disableMutation.isError && (
        <Notice
          tone="error"
          className="mt-4"
          data-testid="auto-top-up-disable-error"
        >
          {t("autoTopUpCard.disableError")}
        </Notice>
      )}

      {isFormMode && (
        <AutoTopUpForm
          initialValues={
            enabled
              ? {
                  threshold_usd: apiToIntStr(config.threshold_usd),
                  amount_usd: apiToIntStr(config.amount_usd),
                  monthly_cap_usd: apiToIntStr(config.monthly_cap_usd),
                }
              : undefined
          }
          submitting={updateMutation.isPending}
          serverErrors={fieldErrors}
          onCancel={exitFormMode}
          onSave={handleSave}
        />
      )}

      <AutoTopUpDisableConfirm
        open={confirmingDisable}
        confirming={disableMutation.isPending}
        onCancel={dismissDisableConfirm}
        onConfirm={handleConfirmDisable}
      />

      <AutoTopUpPaymentMethodModal
        open={pmModalOpen}
        onClose={() => setPmModalOpen(false)}
        onSavedOptimistic={handlePmSaved}
      />
    </div>
  );
}
