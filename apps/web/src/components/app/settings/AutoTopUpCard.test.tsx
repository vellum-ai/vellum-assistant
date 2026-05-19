/**
 * Tests for AutoTopUpCard helpers + heyapi hook smoke contract.
 *
 * The web workspace doesn't pull in @testing-library/react, so we exercise
 * the pure helpers (`extractAutoTopUpServerErrors`,
 * `formatSavedPaymentMethodLine`) and confirm the four heyapi-generated
 * hooks the card depends on are callable factories.
 */

import { describe, expect, test } from "bun:test";

import {
  organizationsBillingAutoTopUpDisableCreateMutation,
  organizationsBillingAutoTopUpRetrieveOptions,
  organizationsBillingAutoTopUpRetrieveQueryKey,
  organizationsBillingAutoTopUpUpdateMutation,
} from "@/generated/api/@tanstack/react-query.gen.js";

import {
  DISABLED_CONFIG,
  extractAutoTopUpServerErrors,
  formatSavedPaymentMethodLine,
} from "@/components/app/settings/AutoTopUpCard.js";

// ---------------------------------------------------------------------------
// extractAutoTopUpServerErrors — DRF field error normalisation
// ---------------------------------------------------------------------------

describe("extractAutoTopUpServerErrors", () => {
  test("flattens the first message per field", () => {
    const out = extractAutoTopUpServerErrors({
      amount_usd: ["Must be between $10 and $500"],
      threshold_usd: ["Must be between $1 and $100"],
    });
    expect(out).toEqual({
      amount_usd: "Must be between $10 and $500",
      threshold_usd: "Must be between $1 and $100",
    });
  });

  test("ignores fields whose value is not an array of strings", () => {
    const out = extractAutoTopUpServerErrors({
      amount_usd: ["msg"],
      noise: { not: "an array" },
      empty: [],
    });
    expect(out).toEqual({ amount_usd: "msg" });
  });

  test("returns an empty object for null / non-object inputs", () => {
    expect(extractAutoTopUpServerErrors(null)).toEqual({});
    expect(extractAutoTopUpServerErrors(undefined)).toEqual({});
    expect(extractAutoTopUpServerErrors("oops")).toEqual({});
    expect(extractAutoTopUpServerErrors(42)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// formatSavedPaymentMethodLine — enabled-state summary copy
// ---------------------------------------------------------------------------

describe("formatSavedPaymentMethodLine", () => {
  test("renders 'Charged to <brand> •••• <last4>' when both fields are present", () => {
    const line = formatSavedPaymentMethodLine({
      brand: "Visa",
      last4: "4242",
    });
    expect(line).toBe("Charged to Visa •••• 4242");
  });

  test("renders 'Charged to <brand>' when only the brand is present", () => {
    const line = formatSavedPaymentMethodLine({ brand: "Mastercard", last4: null });
    expect(line).toBe("Charged to Mastercard");
  });

  test("renders 'Charged to card •••• <last4>' when only last4 is present", () => {
    const line = formatSavedPaymentMethodLine({ brand: null, last4: "0002" });
    expect(line).toBe("Charged to card •••• 0002");
  });

  test("returns null when both fields are null", () => {
    const line = formatSavedPaymentMethodLine({ brand: null, last4: null });
    expect(line).toBeNull();
  });

  test("normalizes lowercase brand strings via the shared brandLabel helper", () => {
    // Pin cross-card consistency: the API returns Stripe's lowercase brand
    // strings (e.g. "visa") and PaymentMethodsCard renders "Visa". The
    // auto-top-up summary must agree, otherwise users see "Charged to visa"
    // directly above "Visa •••• 4242" in the PaymentMethodsCard.
    const line = formatSavedPaymentMethodLine({ brand: "visa", last4: "4242" });
    expect(line).toBe("Charged to Visa •••• 4242");
  });
});

// ---------------------------------------------------------------------------
// heyapi hooks the card depends on (smoke test)
// ---------------------------------------------------------------------------

describe("AutoTopUpCard heyapi hook contract", () => {
  test("organizationsBillingAutoTopUpRetrieveOptions returns an options object", () => {
    const opts = organizationsBillingAutoTopUpRetrieveOptions();
    expect(opts.queryKey).toBeDefined();
    expect(typeof opts.queryFn).toBe("function");
  });

  test("organizationsBillingAutoTopUpRetrieveQueryKey returns a stable key", () => {
    const key = organizationsBillingAutoTopUpRetrieveQueryKey();
    expect(Array.isArray(key)).toBe(true);
  });

  test("organizationsBillingAutoTopUpUpdateMutation returns a mutation factory", () => {
    const opts = organizationsBillingAutoTopUpUpdateMutation();
    expect(typeof opts.mutationFn).toBe("function");
  });

  test("organizationsBillingAutoTopUpDisableCreateMutation returns a mutation factory", () => {
    const opts = organizationsBillingAutoTopUpDisableCreateMutation();
    expect(typeof opts.mutationFn).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// DISABLED_CONFIG — mirrors the payload `_serialize_config(None)` returns
// from the Django backend when no AutoTopUpConfig row exists.
// ---------------------------------------------------------------------------

describe("DISABLED_CONFIG", () => {
  test("represents a fresh disabled config (matches _serialize_config(None) output)", () => {
    expect(DISABLED_CONFIG.enabled).toBe(false);
    expect(DISABLED_CONFIG.threshold_usd).toBeNull();
    expect(DISABLED_CONFIG.amount_usd).toBeNull();
    expect(DISABLED_CONFIG.monthly_cap_usd).toBeNull();
    expect(DISABLED_CONFIG.has_payment_method).toBe(false);
    expect(DISABLED_CONFIG.payment_method_brand).toBeNull();
    expect(DISABLED_CONFIG.payment_method_last4).toBeNull();
    expect(DISABLED_CONFIG.stripe_payment_method_updated_at).toBeNull();
    expect(DISABLED_CONFIG.last_charge_at).toBeNull();
    expect(DISABLED_CONFIG.last_failure_at).toBeNull();
    expect(DISABLED_CONFIG.last_failure_reason).toBeNull();
    expect(DISABLED_CONFIG.paused_until).toBeNull();
    expect(DISABLED_CONFIG.current_month_credits_purchased_usd).toBe("0.00");
    expect(DISABLED_CONFIG.next_trigger_amount_usd).toBeNull();
    expect(DISABLED_CONFIG.stubbed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source-pinning: review-feedback fixes are wired in.
// Documents the four PR 5046 review fixes so future refactors can't silently
// regress the behaviour without flipping this canary.
// ---------------------------------------------------------------------------

describe("AutoTopUpCard — review-feedback fixes (source-pinning)", () => {
  test("calls updateMutation.reset() when entering form mode", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpCard.tsx"),
      "utf-8",
    );
    // Finding 1: the helper must reset prior mutation errors, and both the
    // setup and edit buttons must route through it (no direct setMode).
    expect(source).toContain("updateMutation.reset()");
    expect(source).toContain("const enterFormMode");
    expect(source).toContain('onClick={enterFormMode}');
  });

  test("also resets disableMutation when entering form mode (F6)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpCard.tsx"),
      "utf-8",
    );
    // F6: a previous failed Disable must not leave the error banner
    // visible when the user moves into form mode (Edit / Set up).
    // The helper must reset disableMutation in addition to updateMutation.
    const enterFormMatch = source.match(
      /const enterFormMode = \(\) => \{[\s\S]*?\};/,
    );
    expect(enterFormMatch).not.toBeNull();
    expect(enterFormMatch![0]).toContain("disableMutation.reset()");
  });

  test("also resets disableMutation when dismissing the disable-confirm dialog (F6 bonus)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpCard.tsx"),
      "utf-8",
    );
    // F6 bonus: cancelling the disable confirm dialog after a failed
    // attempt should also clear the stale error banner so the user isn't
    // staring at a failure they've already decided not to retry.
    expect(source).toContain("dismissDisableConfirm");
    const dismissMatch = source.match(
      /const dismissDisableConfirm = \(\) => \{[\s\S]*?\};/,
    );
    expect(dismissMatch).not.toBeNull();
    expect(dismissMatch![0]).toContain("disableMutation.reset()");
    expect(source).toContain("onCancel={dismissDisableConfirm}");
  });

  test("renders an error notice when disableMutation fails", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpCard.tsx"),
      "utf-8",
    );
    // Finding 2: the disable error must surface as a Notice with a
    // dedicated test id; the modal alone doesn't communicate failure.
    expect(source).toContain("disableMutation.isError");
    expect(source).toContain('data-testid="auto-top-up-disable-error"');
  });

  test("handleSave and handleConfirmDisable both merge into GET cache to preserve PM fields read by sibling PaymentMethodsCard", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpCard.tsx"),
      "utf-8",
    );
    // Two distinct patterns, pinned per-flow. Both MUST use a function
    // updater that preserves PM fields from the prior cached value because
    // PaymentMethodsCard (rendered as a sibling on the billing page) reads
    // from the SAME `organizationsBillingAutoTopUpRetrieveQueryKey()` cache
    // — overwriting the cache without preserving PM fields would make
    // PaymentMethodsCard incorrectly render "No payment method on file"
    // until the next GET refetch lands.
    //
    // 1. handleSave MUST seed via setQueryData (synchronous) AND invalidate
    //    (background refresh). A fire-and-forget invalidateQueries alone
    //    leaves configQuery.data on the pre-save value when setMode("view")
    //    re-renders, so the user briefly sees the disabled CTA flash before
    //    the refetch lands. setQueryData merges the PUT response with the
    //    prior cache to preserve payment_method_brand / payment_method_last4
    //    (the PUT path skips Stripe PM retrieve for latency, so those fields
    //    are null on the PUT body). The trailing invalidate refreshes
    //    brand/last4 from GET in the background.
    //
    // 2. handleConfirmDisable MUST seed via setQueryData (not invalidate)
    //    using a function updater that merges DISABLED_CONFIG with prior
    //    PM fields. The disable endpoint only flips `enabled=False` and
    //    preserves `stripe_payment_method_id`, so seeding the cache with
    //    a flat `DISABLED_CONFIG` (which has has_payment_method: false)
    //    would corrupt the sibling PaymentMethodsCard's view of the world.
    const handleSaveMatch = source.match(
      /const handleSave = \(values: AutoTopUpFormValues\) => \{[\s\S]*?\n  \};/,
    );
    expect(handleSaveMatch).not.toBeNull();
    const handleSaveBody = handleSaveMatch![0];
    // Both primitives must be present — setQueryData prevents the flash,
    // invalidate keeps brand/last4 in sync after a card change.
    expect(handleSaveBody).toContain("queryClient.setQueryData");
    expect(handleSaveBody).toContain("queryClient.invalidateQueries");
    expect(handleSaveBody).toContain(
      "organizationsBillingAutoTopUpRetrieveQueryKey",
    );
    // Order matters: the synchronous seed must run before the (async)
    // invalidate so the next render reads the post-save state.
    const setQueryDataIdx = handleSaveBody.indexOf("queryClient.setQueryData");
    const invalidateIdx = handleSaveBody.indexOf(
      "queryClient.invalidateQueries",
    );
    expect(setQueryDataIdx).toBeGreaterThan(-1);
    expect(invalidateIdx).toBeGreaterThan(setQueryDataIdx);
    // The merge function must preserve brand/last4 from the prior cache —
    // the PUT response returns null for those fields by design.
    expect(handleSaveBody).toContain("payment_method_brand: prior?");
    expect(handleSaveBody).toContain("payment_method_last4: prior?");

    const handleConfirmDisableMatch = source.match(
      /const handleConfirmDisable = \(\) => \{[\s\S]*?\n  \};/,
    );
    expect(handleConfirmDisableMatch).not.toBeNull();
    const handleConfirmDisableBody = handleConfirmDisableMatch![0];
    expect(handleConfirmDisableBody).toContain("queryClient.setQueryData");
    expect(handleConfirmDisableBody).toContain("DISABLED_CONFIG");
    expect(handleConfirmDisableBody).not.toContain(
      "queryClient.invalidateQueries",
    );
    // Pin the cross-cache PM-preserving merge: disable endpoint preserves
    // stripe_payment_method_id, so the cache update MUST carry forward
    // has_payment_method / brand / last4 from the prior cached value
    // rather than overwriting them with DISABLED_CONFIG's defaults.
    expect(handleConfirmDisableBody).toContain("has_payment_method: prior?");
    expect(handleConfirmDisableBody).toContain("payment_method_brand: prior?");
    expect(handleConfirmDisableBody).toContain("payment_method_last4: prior?");
    // The SetupIntent staleness marker MUST be preserved across disable so
    // PaymentMethodsCard's Change PM polling doesn't snapshot priorMarker=null
    // and exit on the first poll reading the backend's still-set timestamp.
    // Prettier may wrap the long value onto a continuation line, so match the
    // key declaration and the prior?-fallback as separate substrings rather
    // than a single contiguous slice.
    expect(handleConfirmDisableBody).toContain(
      "stripe_payment_method_updated_at:",
    );
    expect(handleConfirmDisableBody).toContain(
      "prior?.stripe_payment_method_updated_at",
    );
  });

  test("surfaces a generic error notice for non-field update failures", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpCard.tsx"),
      "utf-8",
    );
    // Finding 4: when the update mutation errors with no DRF field
    // payload, a generic notice must render — otherwise Save looks
    // silently no-op.
    expect(source).toContain("updateMutation.isError");
    expect(source).toContain('data-testid="auto-top-up-update-error"');
  });

  test("handleSave converts empty monthly_cap_usd to null before calling the API", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpCard.tsx"),
      "utf-8",
    );
    // The backend AutoTopUpConfigRequestSerializer accepts
    // `monthly_cap_usd: null` for the uncapped scenario, and the Hey-API
    // request type is `string | null` for this field. The form surfaces
    // an empty string when the user wants no cap; the card must convert
    // that to `null` before mutating, otherwise the request goes out
    // with `monthly_cap_usd: ""` which the backend rejects. Pin the
    // conversion in handleSave so a refactor doesn't silently drop it.
    const handleSaveMatch = source.match(
      /const handleSave = \(values: AutoTopUpFormValues\) => \{[\s\S]*?\n  \};/,
    );
    expect(handleSaveMatch).not.toBeNull();
    const body = handleSaveMatch![0];
    expect(body).toContain('values.monthly_cap_usd === ""');
    expect(body).toContain("null");
    // Avoid the prior `...values` spread, which sent the empty string as-is.
    expect(body).not.toContain("...values");
  });
});

// ---------------------------------------------------------------------------
// Source-pinning: PM management has moved out of AutoTopUpCard.
// PaymentMethodsCard is now the single source of truth for Add / Change /
// Remove. AutoTopUpCard renders a no-PM gate notice instead of an inline CTA.
// ---------------------------------------------------------------------------

describe("AutoTopUpCard — no-PM gate (source-pinning)", () => {
  test("pin: handleToggleChange blocks enable when has_payment_method is false", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpCard.tsx"),
      "utf-8",
    );
    const match = source.match(
      /const handleToggleChange = \(next: boolean\) => \{[\s\S]*?\n  \};/,
    );
    expect(match).not.toBeNull();
    const body = match![0];
    expect(body).toContain("!config.has_payment_method");
    expect(body).toContain("setShowNoPmNotice(true)");
  });

  test("pin: useEffect auto-dismisses the no-PM notice when a PM appears", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpCard.tsx"),
      "utf-8",
    );
    const match = source.match(
      /useEffect\(\(\) => \{[\s\S]*?setShowNoPmNotice\(false\)[\s\S]*?\}, \[[\s\S]*?has_payment_method[\s\S]*?\]\);/,
    );
    expect(match).not.toBeNull();
  });

  test("pin: enabled+has_payment_method renders the saved-PM line with no Change button", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpCard.tsx"),
      "utf-8",
    );
    expect(source).toContain('data-testid="auto-top-up-saved-pm"');
    expect(source).toContain("Charged to a saved card");
    expect(source).not.toContain('data-testid="auto-top-up-change-pm-button"');
    expect(source).not.toContain("Change payment method");
  });

  test("pin: enabled+no-PM renders only the warning Notice", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpCard.tsx"),
      "utf-8",
    );
    expect(source).toContain('data-testid="auto-top-up-no-pm"');
    expect(source).toContain("No payment method configured");
    expect(source).toContain("Add one in the Payment Methods section");
    expect(source).not.toContain('data-testid="auto-top-up-add-pm-button"');
  });

  test("pin: AutoTopUpPaymentMethodModal is no longer imported here", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpCard.tsx"),
      "utf-8",
    );
    expect(source).not.toContain("import { AutoTopUpPaymentMethodModal }");
    expect(source).not.toContain("<AutoTopUpPaymentMethodModal");
  });

  test("pin: handlePmSavedOptimistic and pmModalOpen are gone", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpCard.tsx"),
      "utf-8",
    );
    expect(source).not.toContain("handlePmSavedOptimistic");
    expect(source).not.toContain("pmModalOpen");
  });
});
