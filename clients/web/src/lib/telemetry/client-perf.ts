import { readAnalyticsConsent } from "@/lib/telemetry/consent";
import { postTelemetryEvents } from "@/lib/telemetry/ingest";
import { detectClientOs, isNativeMobile } from "@/runtime/platform-detection";

/**
 * Shared emitter for the `client_*` performance families.
 *
 * Rides the existing `watchdog` event shape: `check_name` is an open string,
 * `value` a float magnitude, `detail` an open JSON bag. So a new family lands
 * in the existing `stg_telemetry__watchdog` BigQuery model with no platform
 * work. This is the same ride-an-existing-shape move `memory-telemetry.ts`
 * makes on the `onboarding` event type, and boot-telemetry makes on
 * `watchdog`.
 *
 * Metadata only: detail bags carry no conversation or assistant ids and no
 * raw pathnames. Consent is read at emit time through the shared
 * `readAnalyticsConsent()`, the same decision every other emitter gates on.
 */

/**
 * Groups every perf event from a single page load. Same semantics as
 * boot-telemetry's `boot_id`, minted independently so this module stands alone;
 * the two converge once a caller registers the boot id via
 * `setClientPerfBootId`.
 */
const pageLoadId = crypto.randomUUID();

let bootId: string | null = null;

/**
 * Registers the boot-telemetry boot id so perf families become joinable with
 * the boot series. Called by `startBootTelemetry` once that lands.
 */
export function setClientPerfBootId(id: string): void {
  bootId = id;
}

type PerfSurface = "ios_native" | "android_native" | "web";

/** Mirrors boot-telemetry's surface detection so the labels match its series. */
function detectSurface(): PerfSurface {
  const os = detectClientOs();
  if (!isNativeMobile()) {
    return "web";
  }
  return os === "android" ? "android_native" : "ios_native";
}

/**
 * Fire-and-forget: never throws into the caller's path, so a perf probe can sit
 * on a hot render or navigation path without adding a failure mode.
 */
export function emitClientPerfEvent(
  checkName: string,
  value: number,
  detail?: Record<string, unknown>,
): void {
  try {
    if (!readAnalyticsConsent()) {
      return;
    }
    postTelemetryEvents([
      {
        type: "watchdog",
        daemon_event_id: crypto.randomUUID(),
        recorded_at: Date.now(),
        check_name: checkName,
        value: Math.round(value),
        detail: {
          page_load_id: pageLoadId,
          surface: detectSurface(),
          os: detectClientOs(),
          ...(bootId === null ? {} : { boot_id: bootId }),
          ...detail,
        },
      },
    ]);
  } catch {
    // Telemetry is best-effort.
  }
}

export function __resetClientPerfForTests(): void {
  bootId = null;
}
