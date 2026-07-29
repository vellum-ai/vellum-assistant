import type {
  CreditTierEnum,
  MachineTierEnum,
  StorageTierEnum,
} from "@/generated/api/types.gen";

/**
 * A custom Pro configuration carried on the `/assistant/checkout` deep link,
 * mirroring the upgrade endpoint's per-dimension body. `machineTier: null` is
 * the small baseline and `creditTier: null` is no credit bundle; `storageTier`
 * has no null because the serializer requires it on a package-less upgrade.
 */
export interface CustomCheckoutSelection {
  machineTier: MachineTierEnum | null;
  storageTier: StorageTierEnum;
  creditTier: CreditTierEnum | null;
}

// Param names mirror the upgrade serializer's field names, so a checkout URL
// documents the body it turns into.
export const CUSTOM_MACHINE_PARAM = "machine_tier";
export const CUSTOM_STORAGE_PARAM = "storage_tier";
export const CUSTOM_CREDIT_PARAM = "credit_tier";

const CHECKOUTABLE_MACHINE_TIERS: ReadonlySet<string> =
  new Set<MachineTierEnum>(["medium", "large", "xl"]);

/** Legacy `xl`/`xxl` are excluded: `validate_storage_tier` 400s on them. */
const CHECKOUTABLE_STORAGE_TIERS: ReadonlySet<string> =
  new Set<StorageTierEnum>(["xs", "s", "m", "l"]);

/** `credits_45`/`credits_115` are excluded: they are package-only bundles. */
const CHECKOUTABLE_CREDIT_TIERS: ReadonlySet<string> = new Set<CreditTierEnum>([
  "credits_10",
  "credits_25",
  "credits_50",
  "credits_100",
  "credits_200",
]);

/**
 * The custom configuration a checkout URL names, or `null` when it names none
 * or names one the upgrade endpoint would reject.
 *
 * `machine_tier` and `credit_tier` are optional, but a present-and-invalid
 * value fails the whole parse instead of being dropped: a mangled URL must
 * bail rather than check out a plan the user never configured.
 */
export function parseCustomCheckoutSelection(
  searchParams: URLSearchParams,
): CustomCheckoutSelection | null {
  const storage = searchParams.get(CUSTOM_STORAGE_PARAM);
  if (storage === null || !isCheckoutableStorageTier(storage)) {
    return null;
  }

  const machine = searchParams.get(CUSTOM_MACHINE_PARAM);
  if (machine !== null && !isCheckoutableMachineTier(machine)) {
    return null;
  }

  const credit = searchParams.get(CUSTOM_CREDIT_PARAM);
  if (credit !== null && !isCheckoutableCreditTier(credit)) {
    return null;
  }

  return { machineTier: machine, storageTier: storage, creditTier: credit };
}

/**
 * The checkout query string for a selection, omitting the dimensions it leaves
 * unset. Round-trips through {@link parseCustomCheckoutSelection}.
 */
export function buildCustomCheckoutSearch(
  selection: CustomCheckoutSelection,
): URLSearchParams {
  const search = new URLSearchParams();
  if (selection.machineTier !== null) {
    search.set(CUSTOM_MACHINE_PARAM, selection.machineTier);
  }
  search.set(CUSTOM_STORAGE_PARAM, selection.storageTier);
  if (selection.creditTier !== null) {
    search.set(CUSTOM_CREDIT_PARAM, selection.creditTier);
  }
  return search;
}

function isCheckoutableMachineTier(value: string): value is MachineTierEnum {
  return CHECKOUTABLE_MACHINE_TIERS.has(value);
}

function isCheckoutableStorageTier(value: string): value is StorageTierEnum {
  return CHECKOUTABLE_STORAGE_TIERS.has(value);
}

function isCheckoutableCreditTier(value: string): value is CreditTierEnum {
  return CHECKOUTABLE_CREDIT_TIERS.has(value);
}
