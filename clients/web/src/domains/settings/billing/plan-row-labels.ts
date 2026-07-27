/**
 * The storage and bundled-credit row wordings shared by the package-switch plan
 * highlights and the Custom Plan recap, so the two surfaces cannot drift apart.
 * Kept in its own leaf module — `custom-plan-diff` is deliberately React-free,
 * and importing these from `plan-spec` would drag React in transitively.
 */

import { formatDollars } from "@/domains/settings/components/tier-pricing";

/** "30 GB storage" */
export function storageRowLabel(storageGib: number): string {
  return `${storageGib} GB storage`;
}

/** "$50 of bundled credits" — cents-aware, so a sub-dollar bundle reads "$0.50". */
export function creditRowLabel(creditsUsd: number): string {
  return `${formatDollars(creditsUsd * 100)} of bundled credits`;
}
