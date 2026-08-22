/**
 * Guardian request reminder sweep.
 *
 * Periodically checks for persistent pending guardian requests
 * (`access_request`, `tool_grant_request`) that have been waiting longer than
 * REMINDER_THRESHOLD_MS without any followup, and sends a reminder text to the
 * guardian so requests are not silently forgotten.
 *
 * The gateway atomically claims each eligible row (sets followupState =
 * 'reminded') and returns only the rows it successfully claimed, so the daemon
 * never delivers a reminder for a request that was concurrently resolved or
 * expired. No separate updateGuardianRequest call is needed from the daemon.
 *
 * Reminder delivery routes through the recorded guardian_request_deliveries,
 * not through sourceChannel + guardianExternalUserId, so reminders reach
 * whatever surfaces the original card was sent to. Channels without a
 * deliverable route (e.g. vellum in-app) are skipped silently.
 *
 * Unreachable-gateway posture: log and skip the round.
 */

import { resolveDeliverCallbackUrlForChannel } from "../../approvals/guardian-channel-delivery.js";
import {
  type GuardianRequestDeliveryWire,
  type GuardianRequestWire,
  listGuardianRequestDeliveriesOrEmpty,
  sweepPendingGuardianRequestsForReminders,
} from "../../channels/gateway-guardian-requests.js";
import { getLogger } from "../../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { deliverChannelReply } from "../gateway-client.js";

const log = getLogger("guardian-reminder-sweep");

/** Requests pending longer than this without a followupState get a reminder. */
const REMINDER_THRESHOLD_MS = 10 * 60 * 1000;

/** Interval at which the reminder sweep runs (60 seconds). */
const SWEEP_INTERVAL_MS = 60_000;

/** Timer handle for the sweep so it can be stopped in tests and shutdown. */
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Guard against overlapping sweeps. */
let sweepInProgress = false;

/**
 * Run one reminder sweep round: the gateway atomically claims rows due for a
 * reminder and returns them; the daemon fans out delivery per recorded
 * delivery destination. Returns the count of requests reminded.
 */
export async function runGuardianReminderSweep(
  olderThanMs = REMINDER_THRESHOLD_MS,
): Promise<number> {
  let pending: GuardianRequestWire[];
  try {
    // The gateway atomically marks followupState = 'reminded' and returns
    // only the rows it claimed - no separate updateGuardianRequest needed.
    pending = await sweepPendingGuardianRequestsForReminders(olderThanMs);
  } catch (err) {
    log.warn(
      { err },
      "Guardian reminder sweep skipped - gateway unreachable; next round retries",
    );
    return 0;
  }

  for (const request of pending) {
    log.info(
      {
        event: "guardian_request_reminder_due",
        requestId: request.id,
        kind: request.kind,
        createdAt: request.createdAt,
      },
      "Guardian request pending without action - sending reminder",
    );

    await deliverRemindersForRequest(request);
  }

  if (pending.length > 0) {
    log.info(
      {
        event: "guardian_reminder_sweep_complete",
        remindedCount: pending.length,
      },
      `Guardian reminder sweep: sent ${pending.length} reminder(s)`,
    );
  }

  return pending.length;
}

/**
 * Deliver a reminder to every surface the original approval card was sent to.
 *
 * Routes through the recorded guardian_request_deliveries rather than
 * reconstructing routing from sourceChannel + guardianExternalUserId. The
 * delivery records tell us exactly where the card landed, so the reminder
 * reaches the right channel even when the guardian's notification surfaces
 * differ from the request's source channel.
 *
 * Best-effort and non-throwing: a failed delivery on one surface is logged
 * and does not block the others. followupState is already marked by the time
 * this runs, so failures here are non-fatal.
 */
async function deliverRemindersForRequest(
  request: GuardianRequestWire,
): Promise<void> {
  const deliveries = await listGuardianRequestDeliveriesOrEmpty(request.id);
  if (deliveries.length === 0) {
    return;
  }

  const text = buildReminderText(request);

  for (const delivery of deliveries) {
    await deliverReminderToDestination(request, delivery, text);
  }
}

/**
 * Attempt to deliver a reminder text to one recorded delivery destination.
 *
 * Only surfaces with a callback-less deliver route and a known chatId are
 * attempted. In-app (vellum) and other surfaces without a deliver route are
 * skipped silently.
 */
async function deliverReminderToDestination(
  request: GuardianRequestWire,
  delivery: GuardianRequestDeliveryWire,
  text: string,
): Promise<void> {
  const deliverUrl = resolveDeliverCallbackUrlForChannel(
    delivery.destinationChannel,
  );
  const chatId = delivery.destinationChatId;

  if (!deliverUrl || !chatId) {
    return;
  }

  try {
    await deliverChannelReply(deliverUrl, {
      chatId,
      text,
      assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    });
    log.info(
      {
        requestId: request.id,
        kind: request.kind,
        channel: delivery.destinationChannel,
      },
      "Delivered guardian request reminder",
    );
  } catch (err) {
    log.warn(
      { err, requestId: request.id, channel: delivery.destinationChannel },
      "Failed to deliver guardian request reminder (non-fatal - state already marked)",
    );
  }
}

/** Build a brief reminder message for the given request kind. */
function buildReminderText(request: GuardianRequestWire): string {
  const code = request.requestCode ? ` (code: ${request.requestCode})` : "";
  switch (request.kind) {
    case "access_request":
      return (
        `Reminder: you have an unreviewed access request${code}. ` +
        "Reply with the request code to approve or deny."
      );
    case "tool_grant_request": {
      const tool = request.toolName ? ` for "${request.toolName}"` : "";
      return (
        `Reminder: you have an unreviewed tool grant request${tool}${code}. ` +
        "Reply with the request code to approve or deny."
      );
    }
    default:
      return `Reminder: you have an unreviewed pending request${code}.`;
  }
}

/**
 * Start the periodic guardian reminder sweep. Idempotent - calling it
 * multiple times reuses the same timer.
 */
export function startGuardianReminderSweep(): void {
  if (sweepTimer) {
    return;
  }
  sweepTimer = setInterval(() => {
    if (sweepInProgress) {
      return;
    }
    sweepInProgress = true;
    void runGuardianReminderSweep(REMINDER_THRESHOLD_MS)
      .catch((err) => {
        log.error({ err }, "Guardian reminder sweep failed");
      })
      .finally(() => {
        sweepInProgress = false;
      });
  }, SWEEP_INTERVAL_MS);
}

/**
 * Stop the periodic guardian reminder sweep. Used in tests and shutdown.
 */
export function stopGuardianReminderSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  sweepInProgress = false;
}
