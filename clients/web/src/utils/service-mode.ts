import type { ServiceMode } from "@/generated/daemon/types.gen";

const SERVICE_MODE_VALUES: ReadonlySet<string> = new Set<ServiceMode>([
  "managed",
  "your-own",
]);

/**
 * Validates a raw string (e.g. from localStorage) as a `ServiceMode`.
 * Returns `fallback` when the value is not a known mode.
 */
export function parseServiceMode(
  raw: string | null,
  fallback: ServiceMode,
): ServiceMode {
  return raw !== null && SERVICE_MODE_VALUES.has(raw)
    ? (raw as ServiceMode)
    : fallback;
}
