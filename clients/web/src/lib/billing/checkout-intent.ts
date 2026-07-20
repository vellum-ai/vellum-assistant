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
  | { kind: "package"; packageKey: string; savedAt: number }
  | {
      kind: "custom";
      machineTier: MachineTierEnum | null;
      storageTier: StorageTierEnum | null;
      creditTier: CreditTierEnum | null;
      savedAt: number;
    };

/** A `CheckoutIntent` before `saveCheckoutIntent` stamps `savedAt`. */
export type UnsavedCheckoutIntent =
  | Omit<Extract<CheckoutIntent, { kind: "package" }>, "savedAt">
  | Omit<Extract<CheckoutIntent, { kind: "custom" }>, "savedAt">;

const STORAGE_KEY = "vellum.pro-checkout-intent";
const MAX_AGE_MS = 30 * 60 * 1000;

export function saveCheckoutIntent(intent: UnsavedCheckoutIntent): void {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...intent, savedAt: Date.now() }),
    );
  } catch {
    // sessionStorage may be unavailable (private mode, quota). The stash is a
    // display-only optimization — never block the checkout redirect on it.
  }
}

/**
 * The stashed intent, or `null` when absent, unparsable, malformed, or older
 * than the TTL — anything unusable is cleared so it can't resurface.
 */
export function readCheckoutIntent(): CheckoutIntent | null {
  if (typeof sessionStorage === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

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

export function clearCheckoutIntent(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // see saveCheckoutIntent
  }
}

function isCheckoutIntent(value: unknown): value is CheckoutIntent {
  if (typeof value !== "object" || value === null) return false;
  const intent = value as Partial<CheckoutIntent>;
  if (typeof intent.savedAt !== "number") return false;
  if (intent.kind === "package") {
    return typeof intent.packageKey === "string";
  }
  return intent.kind === "custom";
}
