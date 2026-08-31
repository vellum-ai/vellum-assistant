import { readAnalyticsConsent } from "@/lib/telemetry/consent";
import { postTelemetryEvents } from "@/lib/telemetry/ingest";
import { mintRandomId } from "@/lib/telemetry/random-id";
import {
  detectClientOs,
  isNativeAndroid,
  isNativeIOS,
} from "@/runtime/platform-detection";

/**
 * Shared emitter for the `client_*` performance families.
 *
 * Rides the existing `watchdog` event shape: `check_name` is a closed union
 * client-side but an open string on the wire, `value` a float magnitude,
 * `detail` an open JSON bag. So a new family lands in the existing
 * `stg_telemetry__watchdog` BigQuery model with no platform work. This is the
 * same ride-an-existing-shape move `memory-telemetry.ts` makes on the
 * `onboarding` event type.
 *
 * Detail-bag convention, so the families stay queryable together:
 *   - Values are raw JSON scalars. Numbers stay numbers, booleans stay
 *     booleans. Never stringify a numeric, and never use a string sentinel
 *     like "unknown": both force a cast before any aggregation.
 *   - An unknown or unavailable value is `null`.
 *   - A bounded nested object is allowed when its keys are a closed set (for
 *     example a per-endpoint-group count map). Unbounded key spaces are not.
 *
 * Metadata only: detail bags carry no conversation or assistant ids and no
 * raw pathnames. Consent is read at emit time through the shared
 * `readAnalyticsConsent()`, the same decision every other emitter gates on.
 */

/**
 * Every check name the `client_*` perf families emit. Each member is a series
 * queried by name downstream, so the union is closed: a typo is a compile
 * error rather than a silent phantom series.
 */
export type ClientPerfCheckName =
  | "client_switch.transcript_painted"
  | "client_switch.stalled"
  | "client_switch.abandoned"
  | "client_resume.request_count"
  | "client_list.drain";

let pageLoadId: string | null = null;

/**
 * Groups every perf event from a single page load. Minted on first emit and
 * held for the rest of the page's lifetime, so importing this module has no
 * side effects.
 */
function getPageLoadId(): string {
  pageLoadId ??= mintRandomId();
  return pageLoadId;
}

let bootId: string | null = null;

/**
 * Registers a boot id so the perf families become joinable with a boot series.
 * Until a caller registers one, `boot_id` is absent from the detail bag.
 */
export function setClientPerfBootId(id: string): void {
  bootId = id;
}

type PerfSurface = "ios_native" | "android_native" | "web";

function detectSurface(): PerfSurface {
  if (isNativeIOS()) {
    return "ios_native";
  }
  if (isNativeAndroid()) {
    return "android_native";
  }
  return "web";
}

/**
 * Fire-and-forget: never throws into the caller's path, so a perf probe can sit
 * on a hot render or navigation path without adding a failure mode.
 */
export function emitClientPerfEvent(
  checkName: ClientPerfCheckName,
  value: number,
  detail?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!readAnalyticsConsent()) {
      return;
    }
    postTelemetryEvents([
      {
        type: "watchdog",
        daemon_event_id: mintRandomId(),
        recorded_at: Date.now(),
        check_name: checkName,
        value: Math.round(value),
        detail: {
          page_load_id: getPageLoadId(),
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
  pageLoadId = null;
}
