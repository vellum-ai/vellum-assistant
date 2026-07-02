/**
 * Attribution for stalls between consecutive streamed deltas of one
 * provider call.
 *
 * The daemon forwards each provider delta to clients on the single
 * event-loop thread, so a gap between two deltas is either upstream (the
 * provider paced its output) or local (other work held the loop between
 * the two SDK callbacks). The event-loop watchdog only reports blocks past
 * its 5s floor and the turn tracker only stamps time-to-first-token, so
 * sub-second mid-stream stalls are otherwise invisible.
 *
 * A monitor is created per provider call and fed every streamed
 * text/thinking delta. When the gap since the previous delta crosses
 * {@link STREAM_GAP_THRESHOLD_MS} it logs a structured warning carrying the
 * section trail (`persistence/slow-sync-log.ts`), which names any
 * instrumented synchronous section that ran between the two deltas — a
 * trail dominated by e.g. a partial-flush or memory-job section pins the
 * gap on event-loop contention, while an empty trail points upstream.
 * Reports also land in `watchdog` telemetry under
 * {@link STREAM_GAP_CHECK_NAME} so gap frequency is queryable alongside
 * freeze reports. Only timing metadata is recorded, never delta content.
 */

import { getSectionTrail } from "../persistence/slow-sync-log.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("stream-gap");

/**
 * Gaps between consecutive streamed deltas at or past this threshold are
 * reported. Env-overridable for tuning verbosity on a live install without
 * a rebuild; falls back to 500ms for any non-positive or unparseable value
 * — below the ~1s gaps under investigation, above normal token cadence.
 */
export const STREAM_GAP_THRESHOLD_MS = ((): number => {
  const raw = Number(process.env.VELLUM_STREAM_GAP_THRESHOLD_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 500;
})();

/**
 * `check_name` for stream-gap telemetry events. Stable so downstream
 * grouping stays consistent; keep it in sync with any admin query.
 */
export const STREAM_GAP_CHECK_NAME = "stream_delta_gap";

/**
 * Cap on reports per provider call so a uniformly slow stream (every gap
 * past threshold) cannot flood the log; the cap is noted on the final
 * report so suppression is visible.
 */
export const MAX_GAP_REPORTS_PER_CALL = 10;

export type StreamDeltaKind = "text" | "thinking";

export interface StreamGapReport {
  gapMs: number;
  kind: StreamDeltaKind;
  prevKind: StreamDeltaKind;
  /** 1-based index of the delta that closed the gap within this call. */
  deltaIndex: number;
  suppressingFurtherReports: boolean;
}

export interface StreamGapMonitor {
  /** Record one streamed delta; reports when the gap since the previous
   * delta crosses the threshold. The first delta only starts the clock —
   * time before it is time-to-first-token, owned by the turn tracker. */
  onDelta(kind: StreamDeltaKind): void;
}

export interface StreamGapMonitorOptions {
  /** Static attribution context merged into every report (ids only). */
  context?: Record<string, string | undefined>;
  thresholdMs?: number;
  now?: () => number;
  /** Report sink override for tests; defaults to log + telemetry. */
  onReport?: (report: StreamGapReport) => void;
}

export function createStreamGapMonitor(
  options: StreamGapMonitorOptions = {},
): StreamGapMonitor {
  const {
    context = {},
    thresholdMs = STREAM_GAP_THRESHOLD_MS,
    now = () => performance.now(),
  } = options;
  const onReport = options.onReport ?? defaultReport(context);

  let lastDeltaAt: number | null = null;
  let lastKind: StreamDeltaKind | null = null;
  let deltaIndex = 0;
  let reportCount = 0;

  return {
    onDelta(kind: StreamDeltaKind): void {
      const at = now();
      deltaIndex += 1;
      const prevAt = lastDeltaAt;
      const prevKind = lastKind;
      lastDeltaAt = at;
      lastKind = kind;
      if (prevAt === null || prevKind === null) {
        return;
      }
      const gapMs = at - prevAt;
      if (gapMs < thresholdMs || reportCount >= MAX_GAP_REPORTS_PER_CALL) {
        return;
      }
      reportCount += 1;
      onReport({
        gapMs: Math.round(gapMs),
        kind,
        prevKind,
        deltaIndex,
        suppressingFurtherReports: reportCount >= MAX_GAP_REPORTS_PER_CALL,
      });
    },
  };
}

function defaultReport(
  context: Record<string, string | undefined>,
): (report: StreamGapReport) => void {
  return (report) => {
    // The trail is the "why": it names the instrumented sections that ran
    // between the two deltas. Attached to the telemetry detail as well as
    // the log line so aggregate views carry attribution, not just counts.
    // Trail entries are static labels + ages — never content.
    const detail = { ...context, ...report, sectionTrail: getSectionTrail() };
    log.warn(detail, "Gap between consecutive streamed deltas");
    // Lazy dynamic import for the same reason as `reportSlowSync`: keeping
    // the telemetry → consent-cache → config chain off this module's static
    // graph. Best-effort; a failure must never surface into the stream.
    void import("../telemetry/watchdog-events-store.js")
      .then(({ recordWatchdogEvent }) => {
        recordWatchdogEvent({
          checkName: STREAM_GAP_CHECK_NAME,
          value: report.gapMs,
          detail,
        });
      })
      .catch(() => {
        // Telemetry is best-effort — never let it escape the stream path.
      });
  };
}
