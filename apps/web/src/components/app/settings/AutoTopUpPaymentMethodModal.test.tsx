/**
 * Source-pinning + heyapi-hook smoke tests for AutoTopUpPaymentMethodModal.
 *
 * The web workspace doesn't pull in @testing-library/react, so we mirror
 * the AutoTopUpCard.test.tsx style: confirm the heyapi mutation factory is
 * callable and read the source file to pin behaviour that isn't otherwise
 * exercised at the type level (Stripe Elements wiring, success-path
 * callback ordering, error fallback).
 */

import { describe, expect, test } from "bun:test";

import { organizationsBillingAutoTopUpSetupIntentCreateMutation } from "@/generated/api/@tanstack/react-query.gen.js";

// ---------------------------------------------------------------------------
// heyapi hook the modal depends on (smoke test)
// ---------------------------------------------------------------------------

describe("AutoTopUpPaymentMethodModal heyapi hook contract", () => {
  test("organizationsBillingAutoTopUpSetupIntentCreateMutation returns a mutation factory", () => {
    const opts = organizationsBillingAutoTopUpSetupIntentCreateMutation();
    expect(typeof opts.mutationFn).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Source pinning — confirms the Stripe Elements wiring, mutation usage, and
// success-path ordering match the plan. These tests intentionally read the
// component source because we can't render Stripe Elements in this test
// runner.
// ---------------------------------------------------------------------------

describe("AutoTopUpPaymentMethodModal — source pinning", () => {
  test("uses the heyapi setup-intent mutation factory by name", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpPaymentMethodModal.tsx"),
      "utf-8",
    );
    expect(source).toContain(
      "organizationsBillingAutoTopUpSetupIntentCreateMutation",
    );
    // Pin that the mutation is wired through useMutation, not a hand-rolled
    // fetch wrapper.
    expect(source).toContain("useMutation");
  });

  test("imports Stripe Elements primitives", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpPaymentMethodModal.tsx"),
      "utf-8",
    );
    // The plan calls for Elements + PaymentElement + useStripe + useElements
    // imported from @stripe/react-stripe-js. Pin all four — losing any one
    // means the modal can no longer render the card form.
    expect(source).toContain("Elements");
    expect(source).toContain("PaymentElement");
    expect(source).toContain("useStripe");
    expect(source).toContain("useElements");
    expect(source).toContain('from "@stripe/react-stripe-js"');
    // Pin loadStripe singleton wiring.
    expect(source).toContain('from "@stripe/stripe-js"');
    expect(source).toContain("loadStripe");
  });

  test("triggers the SetupIntent mutation when the modal opens", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpPaymentMethodModal.tsx"),
      "utf-8",
    );
    // Plan step 2: "Trigger the mutation when the modal opens (via
    // useEffect on open=true)." Pin the useEffect + mutate wiring so a
    // refactor that drops the auto-trigger trips this test.
    expect(source).toContain("useEffect");
    // Pin that the mutation `mutate` function fires when `open` flips true.
    expect(source).toMatch(/createSetupIntent\(\{\}\)/);
  });

  test("calls confirmSetup with redirect: 'if_required'", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpPaymentMethodModal.tsx"),
      "utf-8",
    );
    // Stripe's `redirect: "if_required"` keeps in-page success on
    // non-3DS cards. Without it, every confirm would full-page redirect
    // and break the success-toast/optimistic-invalidate flow.
    expect(source).toContain("stripe.confirmSetup");
    expect(source).toContain('redirect: "if_required"');
    expect(source).toContain("confirmParams");
    expect(source).toContain("window.location.href");
  });

  test("on confirmSetup success calls onSavedOptimistic AND onClose", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpPaymentMethodModal.tsx"),
      "utf-8",
    );
    // The whole point of the modal is that the parent re-fetches and
    // closes after a save. Pin both calls — losing either silently
    // regresses UX (stale "no PM saved" copy or a stuck-open modal).
    expect(source).toContain("onSavedOptimistic()");
    expect(source).toContain("onClose()");
    expect(source).toContain("toast.success");
    // Devin PR-5676 review: the modal must `await onSavedOptimistic()` so
    // the parent's cache invalidation lands before `onClose()` fires.
    // Without the await, the user briefly sees stale PM copy after a save.
    expect(source).toMatch(/await\s+onSavedOptimistic\(\)/);
  });

  test("onSavedOptimistic prop type allows a Promise return", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpPaymentMethodModal.tsx"),
      "utf-8",
    );
    // The prop signature must be widened so async parents (the
    // optimistic-refetch callback in AutoTopUpCard) type-check when the
    // modal awaits the return value. Pin the exact shape so a refactor
    // that narrows it back to `() => void` trips this canary.
    expect(source).toMatch(
      /onSavedOptimistic:\s*\(\)\s*=>\s*void\s*\|\s*Promise<void>/,
    );
  });

  test("SetupCardForm awaits onSuccess inside a try/finally", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpPaymentMethodModal.tsx"),
      "utf-8",
    );
    // Devin PR-5676 review: the form must await `onSuccess()` and reset
    // the submitting flag in `finally` so the spinner stays visible while
    // the parent's cache invalidates AND clears reliably even if
    // `onSuccess` throws.
    expect(source).toMatch(/onSuccess:\s*\(\)\s*=>\s*void\s*\|\s*Promise<void>/);
    expect(source).toMatch(/await\s+onSuccess\(\)/);
    expect(source).toContain("} finally {");
    expect(source).toContain("setSubmitting(false)");
  });

  test("renders an error notice with a Try again button when the SetupIntent fetch fails", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpPaymentMethodModal.tsx"),
      "utf-8",
    );
    // Plan step 2: error state must show a Notice tone="error" + a Try
    // again button that re-runs the mutation. Pin both.
    expect(source).toContain('tone="error"');
    expect(source).toContain("Try again");
    expect(source).toContain("setupIntentMutation.isError");
  });

  test("docstring describes the org's single Stripe customer (not a separate auto-top-up customer)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpPaymentMethodModal.tsx"),
      "utf-8",
    );
    // The docstring previously claimed an "auto-top-up Stripe customer"
    // existed. There is no separate customer — auto-top-up reuses the
    // org's single Stripe customer (the same one PaymentMethodViewSet
    // uses) and tags the card via SetupIntent metadata. Pin the corrected
    // wording so a future edit can't silently regress.
    expect(source).toContain("org's Stripe customer");
    expect(source).toContain("SetupIntent metadata");
    expect(source).not.toContain("auto-top-up Stripe customer");
  });

  test("skips setup-intent mutation when STRIPE_PK is empty", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpPaymentMethodModal.tsx"),
      "utf-8",
    );
    // Codex PR-5696 review: when `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is
    // empty, the modal can only render `<MissingStripeKeyNotice />` — but
    // every open of the modal previously fired `createSetupIntent({})`,
    // which spawns an orphan SetupIntent (and bootstraps a Stripe Customer
    // for the org if missing) the user can never complete. Pin the guard
    // that short-circuits the mutation when Stripe Elements cannot mount.
    expect(source).toMatch(/if\s*\(!STRIPE_PK\)\s*return/);
    // The guard must sit inside the open-effect, before the mutation call.
    expect(source).toMatch(
      /if\s*\(!STRIPE_PK\)\s*return;[\s\S]{0,200}createSetupIntent\(\{\}\)/,
    );
  });

  test("missing-STRIPE_PK fallback uses generic user copy and logs a dev warning", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpPaymentMethodModal.tsx"),
      "utf-8",
    );
    // User-facing copy must not reference the dev env var name (end users
    // can't act on it). The actionable hint stays as a console.warn for
    // developers.
    expect(source).toContain(
      "Payment method setup is currently unavailable. Please try again later.",
    );
    expect(source).not.toContain(
      "Set NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    );
    expect(source).toContain("console.warn");
    expect(source).toContain("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY");
  });
});
