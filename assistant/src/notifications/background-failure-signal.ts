import type { BackgroundJobErrorKind } from "../runtime/background-job-runner.js";
import { getLogger } from "../util/logger.js";
import { activityFailedDedupeKey } from "./activity-failed-dedupe.js";
import { emitNotificationSignal } from "./emit-signal.js";
import type { NotificationSourceChannel } from "./signal.js";

const log = getLogger("background-failure-signal");

/**
 * One background failure, as a producer reports it.
 *
 * The classification fields are the authored attribution carried out of the
 * failing turn (`TurnFailure`): `failureSummary` is the classifier's
 * user-facing message, and `profileName`/`connectionName` name the route the
 * call actually resolved. Producers whose failures never ran a turn (a
 * timeout, a bootstrap crash, a data job's own exception) leave them unset
 * and the signal degrades to the classified kind.
 */
export interface BackgroundFailureReport {
  /** Stable job identifier for logs and per-job dedupe, e.g. `heartbeat`. */
  jobName: string;
  /** Human-facing job label for notification copy. Defaults to `jobName`. */
  displayName?: string;
  sourceChannel: NotificationSourceChannel;
  /** Conversation or job id the notification links back to. */
  sourceContextId: string;
  errorKind: BackgroundJobErrorKind;
  /** Raw error text, carried for debugging; copy prefers `failureSummary`. */
  errorMessage: string;
  /** Stable classified code (`ConversationErrorCode`), when classified. */
  failureCode?: string;
  /** The classification's authored user-facing message, when carried. */
  failureSummary?: string;
  /** The classification's machine-readable category, when carried. */
  errorCategory?: string;
  /**
   * Connection row the failing call resolved, when carried. The most precise
   * route identity, so it leads the dedupe-scope hierarchy.
   */
  connectionName?: string;
  /** Profile key the failing call resolved, when carried. */
  profileName?: string;
  /**
   * Recomputed single-route profile key (see `resolveSingleRouteProfileKey`).
   * Used only when the failure carries no attribution of its own.
   */
  fallbackProviderScope?: string;
}

/**
 * The single emission seam for background-job failure notifications.
 *
 * Owns the payload shape, the dedupe-key derivation, and the attention hints
 * so every producer (the background-job runner, the scheduler's
 * retries-exhausted alert, standalone data jobs) reports the same way and a
 * new producer cannot invent a divergent one. Fire-and-forget: emission
 * errors are logged, never thrown, because a notification failure must not
 * break the job path that reports it.
 *
 * The dedupe scope is the most precise route identity the failure carries:
 * the resolved connection, else the resolved profile, else the recomputed
 * fallback. Failures carrying less precision can split an incident into an
 * extra notification (never merge two incidents into one), and the split
 * shrinks as more paths carry attribution.
 */
export function emitBackgroundFailureSignal(
  report: BackgroundFailureReport,
): void {
  const providerScope =
    report.connectionName ?? report.profileName ?? report.fallbackProviderScope;
  emitNotificationSignal({
    sourceChannel: report.sourceChannel,
    sourceContextId: report.sourceContextId,
    sourceEventName: "activity.failed",
    dedupeKey: activityFailedDedupeKey({
      jobName: report.jobName,
      errorKind: report.errorKind,
      ...(report.failureCode !== undefined
        ? { failureCode: report.failureCode }
        : {}),
      ...(providerScope !== undefined ? { providerScope } : {}),
    }),
    contextPayload: {
      jobName: report.displayName ?? report.jobName,
      errorMessage: report.errorMessage,
      errorKind: report.errorKind,
      ...(report.failureCode !== undefined
        ? { failureCode: report.failureCode }
        : {}),
      ...(report.failureSummary !== undefined
        ? { failureSummary: report.failureSummary }
        : {}),
      ...(report.errorCategory !== undefined
        ? { errorCategory: report.errorCategory }
        : {}),
      ...(report.connectionName !== undefined
        ? { connectionName: report.connectionName }
        : {}),
    },
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
  }).catch((emitErr) => {
    log.warn(
      {
        err: emitErr instanceof Error ? emitErr.message : String(emitErr),
        jobName: report.jobName,
        sourceContextId: report.sourceContextId,
      },
      "Failed to emit background-failure notification",
    );
  });
}
