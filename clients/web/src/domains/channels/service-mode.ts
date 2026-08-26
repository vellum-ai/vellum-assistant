import type { ServiceMode } from "@/generated/daemon/types.gen";

/**
 * Validates a raw string (e.g. from localStorage) as a `ServiceMode`.
 * Returns `fallback` when the value is not a known mode.
 */
export function parseServiceMode(
  raw: string | null,
  fallback: ServiceMode,
): ServiceMode {
  return raw === "managed" || raw === "your-own" ? raw : fallback;
}
