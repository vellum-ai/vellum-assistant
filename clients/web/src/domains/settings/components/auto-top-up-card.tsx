import { Info, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { brandLabel, formatBrandLast4 } from "@/domains/settings/utils/payment-method-brand";
import {
    organizationsBillingAutoTopUpDisableCreateMutation,
    organizationsBillingAutoTopUpRetrieveOptions,
    organizationsBillingAutoTopUpRetrieveQueryKey,
    organizationsBillingAutoTopUpRetrieveSetQueryData,
    organizationsBillingAutoTopUpUpdateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";
import { Toggle } from "@vellumai/design-library/components/toggle";
import { Typography } from "@vellumai/design-library/components/typography";

import { AutoTopUpDisableConfirm } from "@/domains/settings/components/auto-top-up-disable-confirm";
import {
    AutoTopUpForm,
    type AutoTopUpFormValues,
} from "@/domains/settings/components/auto-top-up-form";
import { AutoTopUpPaymentMethodModal } from "@/domains/settings/components/auto-top-up-payment-method-modal";

type Mode = "view" | "form";

/** Convert API-format decimal string (e.g. "25.00") to integer string ("25") for form display. */
function apiToIntStr(v: string | null | undefined): string {
  if (!v) return "";
  const n = parseFloat(v);
  return Number.isFinite(n) ? String(Math.trunc(n)) : "";
}

/**
 * Format a USD decimal string like "25.00" as "$25" (or "$25.50" if non-zero
 * cents). Used for the inline summary in the enabled-not-configuring view
 * ("Add $200 when the balance falls under $50").
 */
function formatUsdShort(value: string | null | undefined): string {
  if (!value) return "$0";
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return "$0";
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const stripped = formatted.endsWith(".00")
    ? formatted.slice(0, -3)
    : formatted;
  return n < 0 ? `-$${stripped}` : `$${stripped}`;
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
 * Flatten DRF field errors (`{ field: [msg, ...] }`) into a single message
 * per field. Exported so unit tests can exercise the parsing without
 * rendering the card.
 */
export function extractAutoTopUpServerErrors(err: unknown): Record<string, string> {
  if (!err || typeof err !== "object" || Array.isArray(err)) return {};
  const out: Record<string, string> = {};
  for (const [key, messages] of Object.entries(err)) {
    if (Array.isArray(messages) && typeof messages[0] === "string") {
      out[key] = messages[0];
    }
  }
  return out;
}

/**
 * Build the saved-PM display string for the enabled-state summary:
 * - "Charged to <brand> •••• <last4>" when both fields are present
 * - "Charged to <brand>" when only the brand is present
 * - null when neither is present (caller renders nothing)
 *
 * The "<brand> •••• <last4>" shape comes from `formatBrandLast4` in
 * `utils/payment-method-brand.ts`, which owns the brand-fallback (`"card"`)
 * and last4-fallback (`"????"`).
 */
export function formatSavedPaymentMethodLine(args: {
  brand: string | null;
  last4: string | null;
}): string | null {
  const { brand, last4 } = args;
  if (!brand && !last4) return null;
  // When last4 is missing we render "Charged to <brand>" (no bullets), so
  // we don't route through formatBrandLast4 here — that helper always
  // emits the "•••• <last4>" tail.
  if (!last4) return `Charged to ${brandLabel(brand ?? "card")}`;
  return `Charged to ${formatBrandLast4(brand, last4)}`;
}

/**
 * Settings → Billing auto-reload section. Embedded directly inside the
 * Credit Balance card by `BillingPanel.tsx` (no outer Card wrapper of its
 * own). Toggle controls enable/disable; Adjust enters configure mode. This
 * card also owns saving a new payment method (via
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
  const queryClient = useQueryClient();
  const configQuery = useQuery(organizationsBillingAutoTopUpRetrieveOptions());
  const updateMutation = useMutation(organizationsBillingAutoTopUpUpdateMutation());
  const disableMutation = useMutation(
    organizationsBillingAutoTopUpDisableCreateMutation(),
  );

  const [mode, setMode] = useState<Mode>("view");
  const [pendingEnable, setPendingEnable] = useState(false);
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [showAddPm, setShowAddPm] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [pmModalOpen, setPmModalOpen] = useState(false);

  // Auto-dismiss the no-PM gate once a PM appears (e.g. after the user saves
  // one via `AutoTopUpPaymentMethodModal` below). Declared before the
  // early-return branches to satisfy rules-of-hooks; reads through
  // `configQuery.data` since `config` isn't bound until after the
  // loading/error guards below.
  useEffect(() => {
    if (showAddPm && configQuery.data?.has_payment_method) {
      setShowAddPm(false);
    }
  }, [showAddPm, configQuery.data?.has_payment_method]);

  if (configQuery.isLoading) {
    return (
      <div data-testid="auto-top-up-card">
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          Loading…
        </p>
      </div>
    );
  }
  if (configQuery.isError || !configQuery.data) {
    return (
      <div data-testid="auto-top-up-card">
        <Notice tone="error">Failed to load auto top-up configuration.</Notice>
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

  /**
   * Transition into form mode. Resets any prior mutation errors so stale
   * field-level errors (from `updateMutation`) or the disable-failure
   * banner (from `disableMutation`) don't render the moment the form
   * re-mounts (e.g. after Cancel + re-Edit, or after a failed Disable).
   */
  const enterFormMode = () => {
    updateMutation.reset();
    disableMutation.reset();
    setMode("form");
  };

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
              // in `handlePmSaved` below: it reads `priorMarker` from this
              // same cache, then polls until the backend's marker advances
              // past it. If we seed `null` after disable, the user's next
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
   * Click handler for the "Enable Extra Usage" toggle. The toggle itself is
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
      setPendingEnable(true);
      if (!config.has_payment_method || disabledAfterDeclines) {
        setShowAddPm(true);
        setBannerDismissed(false);
        return;
      }
      setShowAddPm(false);
      enterFormMode();
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
   * The `setup_intent.succeeded` webhook persists `stripe_payment_method_id`
   * asynchronously, so a single invalidate+refetch can race the webhook and
   * leave the cache stale. Poll until `stripe_payment_method_updated_at`
   * actually advances past its pre-save value, with a timeout so this never
   * spins forever if the webhook never lands. Once the PM is confirmed
   * fresh, drop the no-PM gate and — if the user got here via the toggle —
   * advance straight into the configure form.
   */
  const handlePmSaved = async () => {
    const POLL_INTERVAL_MS = 1500;
    const MAX_POLL_MS = 20_000;
    const start = Date.now();
    const priorMarker = config.stripe_payment_method_updated_at ?? null;

    try {
      await queryClient.invalidateQueries({
        queryKey: organizationsBillingAutoTopUpRetrieveQueryKey(),
      });
    } catch {
      // fall through to polling below
    }

    while (Date.now() - start < MAX_POLL_MS) {
      try {
        const refetched = await queryClient.fetchQuery(
          organizationsBillingAutoTopUpRetrieveOptions(),
        );
        if (
          refetched.has_payment_method &&
          refetched.stripe_payment_method_updated_at !== priorMarker
        ) {
          break;
        }
      } catch {
        // sleep and retry
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    setShowAddPm(false);
    if (pendingEnable) {
      enterFormMode();
    }
  };

  const isFormMode = mode === "form";
  const fieldErrors = extractAutoTopUpServerErrors(updateMutation.error);
  // Surface a generic notice when the mutation failed but no field-level
  // DRF errors were parsed (network failure, 5xx, non-DRF body, etc.).
  // Without this, a failed Save can otherwise look like a silent no-op.
  const showGenericUpdateError =
    updateMutation.isError && Object.keys(fieldErrors).length === 0;

  const toggleChecked = enabled || pendingEnable;
  const savedPmLine = formatSavedPaymentMethodLine({
    brand: config.payment_method_brand,
    last4: config.payment_method_last4,
  });

  return (
    <div data-testid="auto-top-up-card">
      <div className="flex items-center justify-between gap-4">
        <Toggle
          checked={toggleChecked}
          onChange={handleToggleChange}
          label="Enable Extra Usage"
        />

        {enabled && !isFormMode && (
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p
                className="text-body-small-default text-[var(--content-tertiary)]"
                data-testid="auto-top-up-summary"
              >
                Add {formatUsdShort(config.amount_usd)} when the balance falls
                under {formatUsdShort(config.threshold_usd)}
              </p>
              {config.monthly_cap_usd != null && (
                <p
                  className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]"
                  data-testid="auto-top-up-cap-progress"
                >
                  {formatUsdShort(config.current_month_credits_purchased_usd)} of{" "}
                  {formatUsdShort(config.monthly_cap_usd)} this month
                </p>
              )}
            </div>
            <Button
              variant="outlined"
              onClick={enterFormMode}
              data-testid="auto-top-up-edit-button"
            >
              Adjust
            </Button>
          </div>
        )}
      </div>

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
              Add payment method
            </Button>
          }
        >
          We paused automatic reloads after several declined payments. Add a new
          payment method to turn auto-reload back on.
        </Notice>
      )}

      <div
        className="grid transition-[grid-template-rows] duration-200 ease-in-out"
        style={{
          gridTemplateRows:
            showAddPm && !disabledAfterDeclines ? "1fr" : "0fr",
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
                    Extra usage requires you to connect a credit card.
                  </Typography>
                </div>
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => setBannerDismissed(true)}
                  className="flex shrink-0 cursor-pointer items-center justify-center rounded p-0.5 text-[var(--system-mid-strong)] opacity-70 transition-opacity hover:opacity-100"
                >
                  <X className="h-2.5 w-2.5" strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            )}
            <Button
              variant="primary"
              onClick={() => setPmModalOpen(true)}
              data-testid="auto-top-up-add-pm-button"
              className="self-start"
            >
              Add a Credit Card
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
          Failed to save automatic top-ups. Please try again.
        </Notice>
      )}

      {disableMutation.isError && (
        <Notice
          tone="error"
          className="mt-4"
          data-testid="auto-top-up-disable-error"
        >
          Failed to disable automatic top-ups. Please try again.
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

      {enabled && config.has_payment_method && (
        <p
          className="mt-3 text-body-small-default text-[var(--content-tertiary)]"
          data-testid="auto-top-up-saved-pm"
        >
          {savedPmLine ?? "Charged to a saved card"}
        </p>
      )}

      {(enabled || isFormMode) && (
        <Notice tone="info" className="mt-4">
          If you&apos;re too close to your monthly limit, the auto-reload will
          only top up to that limit.
        </Notice>
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
