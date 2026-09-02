import { telemetryIngestPost } from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";
import type { TelemetryJsonValueWritable } from "@/generated/daemon/types.gen";
import { readAnalyticsConsent } from "@/lib/telemetry/consent";
import { mintRandomId } from "@/lib/telemetry/random-id";
import {
  __resetReportedConditionsForTests,
  claimUnreportedConditions,
} from "@/lib/telemetry/report-once";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  detectClientOs,
  isNativeAndroid,
  isNativeIOS,
} from "@/runtime/platform-detection";

/**
 * Shared transport and emitter for the `client_*` performance families.
 *
 * ## Transport
 *
 * Events post to the daemon's `/v1/assistants/{id}/telemetry/ingest` route
 * and reach the warehouse through the daemon's outbox (with its retry and
 * offline durability) under its API key. The relay is the one transport
 * reachable in every mode the web client runs in; platform session ingest is
 * not (its allowlist drops `watchdog` from browsers, and remote-gateway and
 * local modes cannot reach it at all), so never route these events there.
 *
 * The daemon stamps the base fields: `recorded_at` is daemon receipt time,
 * not emit time, so timing data must ride `value`/`detail`, never be inferred
 * from `recorded_at`. The daemon also re-checks the owner's `share_analytics`
 * consent; the client-side `readAnalyticsConsent()` gate stays so the
 * viewing user's own opt-out holds regardless of the owner's.
 *
 * An event with no resolvable assistant has no relay target and drops
 * silently in `sendClientWatchdogEvent`. Terminal boot flushes run after
 * resolution, so in practice this loses only early-pagehide boots and
 * surfaces that never reach an assistant.
 *
 * ## Shape
 *
 * Rides the `watchdog` event: `check_name` is a closed union client-side but
 * an open string on the wire, `value` a float magnitude, `detail` an open
 * JSON bag (4096 serialized bytes, enforced server-side). The `client_`
 * prefix keeps the families disjoint from the daemon's own health checks in
 * the shared `watchdog_raw` table.
 *
 * Detail-bag convention, so the families stay queryable together:
 *   - Values are raw JSON scalars. Numbers stay numbers, booleans stay
 *     booleans. Never stringify a numeric, and never use a string sentinel
 *     like "unknown": both force a cast before any aggregation.
 *   - An unknown or unavailable value is `null`.
 *   - A bounded nested object is allowed when its keys are a closed set (for
 *     example the boot event's per-mark duration map). Unbounded key spaces
 *     are not.
 *
 * Metadata only: detail bags carry no conversation ids and no raw pathnames.
 */

/**
 * Every check name the `client_*` perf families emit. Each member is a series
 * queried by name downstream, so the union is closed: a typo is a compile
 * error rather than a silent phantom series.
 */
/**
 * A detail bag: JSON-safe values only, typed by the wire contract so a
 * non-serializable value is a compile error at the emit site.
 */
export type ClientPerfDetail = Record<string, TelemetryJsonValueWritable>;

export type ClientPerfCheckName =
  | "client_boot"
  | "client_switch.transcript_painted"
  | "client_switch.stalled"
  | "client_switch.abandoned"
  | "client_resume.request_count"
  | "client_resume.to_sse_open"
  | "client_list.drain";

/**
 * Posts one `client_*` watchdog event through the daemon relay. Fire and
 * forget: never throws into the caller, so a probe can sit on a hot render
 * or navigation path without adding a failure mode. Transport failures
 * (network, unreachable daemon) are swallowed; a contract-class 4xx
 * rejection (400/422, the wire refusing the event) is reported to Sentry
 * once per status per page load, because a batch the daemon refuses is
 * silent data loss otherwise. Auth-layer answers (401/403) and pre-relay
 * daemons (404) stay quiet, expected states rather than contract breaks.
 *
 * Precision is the caller's: durations arrive already rounded to whole
 * milliseconds, scores keep their decimals, and `value` is null when the
 * event carries no scalar. Consent is also the caller's, checked immediately
 * before calling, because the families read it at different moments (the
 * boot family buffers marks and checks at flush; the others check at emit).
 */
export function sendClientWatchdogEvent(event: {
  checkName: ClientPerfCheckName;
  value: number | null;
  detail: ClientPerfDetail;
  /** Deterministic collapse key; omitted, the daemon mints a per-row id. */
  daemonEventId?: string;
  /**
   * The assistant that owns the measured operation. Events about the surface
   * the user is on (boot, switch arrival, resume) omit this and route to the
   * active assistant; events about one assistant's data (a list drain) must
   * pass the owner, or a switch completing mid-operation would attribute the
   * measurement, and its consent decision, to the wrong assistant.
   */
  assistantId?: string;
}): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const assistantId =
      event.assistantId ??
      useResolvedAssistantsStore.getState().activeAssistantId;
    if (assistantId === null) {
      return;
    }
    void telemetryIngestPost({
      path: { assistant_id: assistantId },
      body: {
        type: "watchdog",
        ...(event.daemonEventId === undefined
          ? {}
          : { daemon_event_id: event.daemonEventId }),
        fields: {
          check_name: event.checkName,
          value: event.value,
          detail: event.detail,
        },
      },
      // The request must survive a pagehide flush.
      keepalive: true,
      throwOnError: false,
    })
      .then(({ response }) => {
        const status = response?.status ?? 0;
        // Only contract-class rejections are reportable. Not reportable:
        // 404, a daemon predating the relay route answers it per event, and
        // telemetry from it is simply absent; 401/403, an auth layer refusing
        // the caller rather than the wire refusing the event (on the cloud
        // proxy path an expired or absent platform session answers 403), the
        // app surfaces signed-out state on its own and every expired-session
        // page load would otherwise report once, forever.
        if (
          status < 400 ||
          status >= 500 ||
          status === 401 ||
          status === 403 ||
          status === 404
        ) {
          return;
        }
        if (claimUnreportedConditions([`relay:${status}`]).length === 0) {
          return;
        }
        captureError(
          new Error(
            `telemetry relay rejected ${event.checkName} with ${status}`,
          ),
          {
            context: "client-perf-relay",
            level: "warning",
            extra: { status, checkName: event.checkName },
          },
        );
      })
      .catch(() => {});
  } catch {
    // Telemetry is best-effort.
  }
}

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
 * Registers a boot id so the perf families become joinable with the boot
 * series. Until a caller registers one, `boot_id` is absent from the detail
 * bag.
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
 * Emits one single-magnitude perf event with the shared context stamp
 * (page-load id, surface, os, boot id). `value` rounds to whole
 * milliseconds; a family whose value is a score builds its event through
 * {@link sendClientWatchdogEvent} directly.
 */
export function emitClientPerfEvent(
  checkName: ClientPerfCheckName,
  value: number,
  detail?: ClientPerfDetail,
  /** Owner of the measured operation; see {@link sendClientWatchdogEvent}. */
  assistantId?: string,
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!readAnalyticsConsent()) {
      return;
    }
    sendClientWatchdogEvent({
      checkName,
      assistantId,
      value: Math.round(value),
      detail: {
        page_load_id: getPageLoadId(),
        surface: detectSurface(),
        os: detectClientOs(),
        ...(bootId === null ? {} : { boot_id: bootId }),
        ...detail,
      },
    });
  } catch {
    // Telemetry is best-effort.
  }
}

export function __resetClientPerfForTests(): void {
  bootId = null;
  pageLoadId = null;
  __resetReportedConditionsForTests();
}
