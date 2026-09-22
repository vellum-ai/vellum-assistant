/**
 * The feature rows of a View All Plans column, derived from the catalog the
 * same way for the page and its stories: the machine, the storage, the usage
 * allowance, then any static extras from the tier copy.
 */
import type { ProPackage } from "@/domains/settings/billing/package-types";
import { machineLabel } from "@/domains/settings/billing/plan-spec";
import { FREE_STORAGE_GIB } from "@/domains/settings/billing/plan-tier-meta";
import type { useTranslation } from "@/i18n";

/** The settings-namespace `t()`, as `useTranslation("settings")` returns it. */
export type SettingsTranslate = ReturnType<
  typeof useTranslation<"settings">
>["t"];

/** Machine label for a package's feature row, e.g. "Medium Computer". */
function machineComputerLabel(
  pkg: ProPackage,
  translate: SettingsTranslate,
): string {
  return translate("plansPage.featureComputer", {
    machine: machineLabel(pkg),
  });
}

/** Catalog-derived feature rows, plus any static extras from the copy. */
export function packageColumnFeatures(
  pkg: ProPackage,
  extra: readonly string[],
  translate: SettingsTranslate,
): string[] {
  return [
    machineComputerLabel(pkg, translate),
    translate("plansPage.featureStorage", { gib: pkg.storage_gib }),
    // The bundle row never names a credit amount: it reads as the package's
    // own usage allowance, derived from the package name the way the plan
    // card's chip is, so it holds even when the catalog carries no
    // `usage_label`.
    translate("plansPage.featureUsage", { name: pkg.name }),
    ...extra,
  ];
}

/** The free column's rows: the small baseline, free storage, pay-as-you-go. */
export function freeColumnFeatures(translate: SettingsTranslate): string[] {
  return [
    translate("plansPage.freeFeatureSmallComputer"),
    translate("plansPage.freeFeatureStorage", { gib: FREE_STORAGE_GIB }),
    translate("plansPage.freeFeaturePayAsYouGo"),
  ];
}
