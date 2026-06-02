/**
 * Friendly error messaging for assistant resize mutations.
 *
 * The backend rejects resizes above the org's plan tier with raw 403 error
 * codes (`exceeds_machine_tier` / `exceeds_storage_tier`). Surfacing those
 * codes verbatim leaks an internal identifier to the user, so map the known
 * codes to plain-language copy and fall back to the shared
 * `extractErrorMessage` util for everything else.
 */
import { extractErrorMessage } from "@/utils/api-errors";

const TIER_ERROR_CODES = new Set([
  "exceeds_machine_tier",
  "exceeds_storage_tier",
]);

/**
 * Turn an unknown resize-mutation error into a user-facing message. Known
 * machine/storage tier codes resolve to a friendly string; anything else
 * delegates to the shared `extractErrorMessage` (with `fallback`).
 */
export function extractResizeError(error: unknown, fallback: string): string {
  if (
    error &&
    typeof error === "object" &&
    !Array.isArray(error) &&
    "error" in error &&
    typeof error.error === "string" &&
    TIER_ERROR_CODES.has(error.error)
  ) {
    return "That size isn't available on your plan.";
  }
  return extractErrorMessage(error, undefined, fallback);
}
