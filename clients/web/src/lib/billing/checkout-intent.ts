import type {
  CreditTierEnum,
  MachineTierEnum,
  StorageTierEnum,
} from "@/generated/api/types.gen";

/**
 * The plan selection captured at the moment a Stripe checkout redirect fires,
 * so the post-checkout provisioning screen can render the purchased upgrade
 * instantly — before the subscribe webhook lands and any API reflects it.
 *
 * Stored in sessionStorage (per-tab, survives the Stripe redirect round-trip,
 * dies with the tab) under a 30-minute TTL: a checkout abandoned longer than
 * that shouldn't resurface as a phantom "provisioning" state.
 */
export type CheckoutIntent =
  | {
      kind: "package";
      packageKey: string;
      savedAt: number;
      /**
       * Marks a stash written by the post-auth signup carry (a pricing-CTA
       * signup routed through consent). Only the onboarding privacy screen
       * resumes checkout from a marked intent, so an ordinary billing-surface
       * stash (CheckoutPage, the plans/adjust takeovers) can't hijack
       * onboarding. Optional and backward-compatible: ordinary saves omit it.
       *
       * The Stripe hand-off rewrites the stash without the marker, so a marked
       * stash is one no checkout ever handed off — see
       * {@link readPurchasedCheckoutIntent}.
       */
      resumeAfterOnboarding?: true;
    }
  | {
      kind: "custom";
      machineTier: MachineTierEnum | null;
      storageTier: StorageTierEnum | null;
      creditTier: CreditTierEnum | null;
      savedAt: number;
      /** The signup carry marker, exactly as on the `package` member above. */
      resumeAfterOnboarding?: true;
    };

/** `Omit` distributed over each member of a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** A `CheckoutIntent` before `saveCheckoutIntent` stamps `savedAt`. */
type UnsavedCheckoutIntent = DistributiveOmit<CheckoutIntent, "savedAt">;

const STORAGE_KEY = "vellum.pro-checkout-intent";
const MAX_AGE_MS = 30 * 60 * 1000;

/**
 * In-memory mirror of the stash, so an unavailable sessionStorage (private
 * mode, quota, storage disabled) can't silently drop the intent. The new-user
 * flow relies on the stash surviving a same-tab signup → privacy hop, which
 * has no Stripe round-trip to justify sessionStorage — the memory copy keeps
 * that hop working even when `sessionStorage.setItem` throws.
 */
let inMemoryIntent: CheckoutIntent | null = null;

export function saveCheckoutIntent(intent: UnsavedCheckoutIntent): void {
  const stamped: CheckoutIntent = { ...intent, savedAt: Date.now() };
  // Always keep the memory copy so a throwing sessionStorage can't lose it.
  inMemoryIntent = stamped;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stamped));
  } catch {
    // sessionStorage may be unavailable (private mode, quota). The in-memory
    // mirror above preserves the stash — never block the checkout redirect.
  }
}

/**
 * The stashed intent, or `null` when absent, unparsable, malformed, or older
 * than the TTL — anything unusable is cleared so it can't resurface. Falls
 * back to the in-memory mirror when sessionStorage is unreachable or empty.
 */
export function readCheckoutIntent(): CheckoutIntent | null {
  let raw: string | null = null;
  if (typeof sessionStorage !== "undefined") {
    try {
      raw = sessionStorage.getItem(STORAGE_KEY);
    } catch {
      // sessionStorage unreachable — fall back to the in-memory mirror.
      return readInMemoryIntent();
    }
  }
  if (!raw) {
    return readInMemoryIntent();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearCheckoutIntent();
    return null;
  }
  if (!isCheckoutIntent(parsed) || Date.now() - parsed.savedAt > MAX_AGE_MS) {
    clearCheckoutIntent();
    return null;
  }
  return parsed;
}

/**
 * The stashed intent when it names an upgrade the user actually paid for,
 * else `null`.
 *
 * A stash still carrying `resumeAfterOnboarding` never reached the Stripe
 * hand-off — the hand-off replaces the record without the marker — so it names
 * an upgrade nobody bought, whichever kind it is. Surfaces that report a
 * purchase to the user read this rather than {@link readCheckoutIntent}, which
 * every bail path would otherwise leave able to render a phantom.
 */
export function readPurchasedCheckoutIntent(): CheckoutIntent | null {
  const intent = readCheckoutIntent();
  if (intent?.resumeAfterOnboarding === true) {
    return null;
  }
  return intent;
}

export function clearCheckoutIntent(): void {
  inMemoryIntent = null;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // see saveCheckoutIntent
  }
}

/**
 * The in-memory mirror, applying the same TTL as the sessionStorage read so an
 * abandoned intent can't resurface. Self-clears an expired mirror.
 */
function readInMemoryIntent(): CheckoutIntent | null {
  if (!inMemoryIntent) {
    return null;
  }
  if (Date.now() - inMemoryIntent.savedAt > MAX_AGE_MS) {
    inMemoryIntent = null;
    return null;
  }
  return inMemoryIntent;
}

function isCheckoutIntent(value: unknown): value is CheckoutIntent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const intent = value as Partial<CheckoutIntent>;
  if (typeof intent.savedAt !== "number") {
    return false;
  }
  if (intent.kind === "package") {
    return typeof intent.packageKey === "string";
  }
  return intent.kind === "custom";
}
