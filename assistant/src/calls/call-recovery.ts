/**
 * Call recovery — reconciles in-flight calls on daemon restart.
 *
 * When the daemon restarts, any calls left in non-terminal states may be stale
 * (the daemon crashed mid-call) or still active on the provider side. This
 * module fetches the actual provider status and transitions each call
 * accordingly.
 */

import { getLogger } from '../util/logger.js';
import { listRecoverableCalls, updateCallSession, expirePendingQuestions } from './call-store.js';
import type { VoiceProvider } from './voice-provider.js';
import type { CallStatus } from './types.js';

type Logger = ReturnType<typeof getLogger>;

const defaultLog = getLogger('call-recovery');

/**
 * Grace period (in ms) for no-SID sessions during startup recovery.
 *
 * A daemon crash can leave a live Twilio call without a persisted SID
 * (crash after `initiateCall` succeeds but before the SID is written).
 * Webhooks carrying the SID may still arrive after restart, so we skip
 * very recent sessions and only fail them once the grace period expires.
 */
export const NO_SID_GRACE_PERIOD_MS = 60_000;

/**
 * Map a Twilio provider status string to our internal CallStatus.
 * Returns the mapped status or null if the status is unrecognised.
 */
function mapProviderStatus(providerStatus: string): CallStatus | null {
  switch (providerStatus) {
    case 'queued':
    case 'ringing':
      return 'ringing';
    case 'in-progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'busy':
    case 'no-answer':
    case 'canceled':
      return 'failed';
    default:
      return null;
  }
}

/**
 * Check whether a CallStatus is terminal (no further transitions allowed).
 */
function isTerminal(status: CallStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Reconcile all non-terminal call sessions at daemon startup.
 *
 * For each recoverable call:
 * - If it has a provider SID, fetch the current status from the provider
 *   and transition the call to match.
 * - If no provider SID exists and the session is recent (< 60 s), skip it
 *   so that webhooks carrying the SID can still arrive after a daemon crash.
 * - If no provider SID exists and the session is older than the grace period,
 *   fail it with an explanatory error message.
 * - If the call transitions to a terminal state, expire any pending questions.
 */
export async function reconcileCallsOnStartup(
  provider: VoiceProvider,
  log: Logger = defaultLog,
): Promise<void> {
  const recoverableCalls = listRecoverableCalls();

  if (recoverableCalls.length === 0) {
    log.info('No recoverable calls found at startup');
    return;
  }

  log.info({ count: recoverableCalls.length }, 'Reconciling non-terminal calls at startup');

  for (const session of recoverableCalls) {
    try {
      if (!session.providerCallSid) {
        const sessionAgeMs = Date.now() - session.createdAt;

        if (sessionAgeMs < NO_SID_GRACE_PERIOD_MS) {
          // Session is recent — the SID may arrive via webhook shortly.
          // Skip it so webhooks can still deliver the SID and resume the call.
          log.info(
            { callSessionId: session.id, previousStatus: session.status, sessionAgeMs },
            'Skipping recent no-SID session (within grace period, webhooks may still arrive)',
          );
          updateCallSession(session.id, {
            lastError: 'Daemon restarted before provider SID persisted; awaiting webhook',
          });
          continue;
        }

        // Session is older than the grace period — fail it cleanly
        log.info(
          { callSessionId: session.id, previousStatus: session.status, sessionAgeMs },
          'Failing stale call with no provider SID (grace period expired)',
        );
        updateCallSession(session.id, {
          status: 'failed',
          endedAt: Date.now(),
          lastError: 'Daemon restarted before call connected to provider',
        });
        expirePendingQuestions(session.id);
        continue;
      }

      // Fetch actual status from provider
      let providerStatus: string;
      try {
        providerStatus = await provider.getCallStatus(session.providerCallSid);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          { callSessionId: session.id, callSid: session.providerCallSid, err },
          'Failed to fetch provider status during recovery — failing call',
        );
        updateCallSession(session.id, {
          status: 'failed',
          endedAt: Date.now(),
          lastError: `Recovery: failed to fetch provider status: ${msg}`,
        });
        expirePendingQuestions(session.id);
        continue;
      }

      const mappedStatus = mapProviderStatus(providerStatus);

      if (!mappedStatus) {
        log.warn(
          { callSessionId: session.id, providerStatus },
          'Unrecognised provider status during recovery — failing call',
        );
        updateCallSession(session.id, {
          status: 'failed',
          endedAt: Date.now(),
          lastError: `Recovery: unrecognised provider status '${providerStatus}'`,
        });
        expirePendingQuestions(session.id);
        continue;
      }

      if (isTerminal(mappedStatus)) {
        // Provider says the call has ended
        log.info(
          { callSessionId: session.id, providerStatus, mappedStatus },
          'Provider reports call ended — transitioning to terminal state',
        );
        updateCallSession(session.id, {
          status: mappedStatus,
          endedAt: Date.now(),
        });
        expirePendingQuestions(session.id);
      } else {
        // Provider says call is still active — leave it for webhooks to handle
        log.info(
          { callSessionId: session.id, providerStatus, mappedStatus },
          'Provider reports call still active — leaving for webhook handling',
        );
      }
    } catch (err) {
      log.error(
        { callSessionId: session.id, err },
        'Unexpected error during call recovery',
      );
    }
  }

  log.info('Call recovery reconciliation complete');
}

/**
 * Log a dead-letter provider event — a provider callback payload that
 * could not be processed (malformed, unknown format, etc.).
 *
 * Rather than silently dropping these events, we log the full payload
 * so operators can investigate later.
 */
export function logDeadLetterEvent(
  reason: string,
  payload: unknown,
  log: Logger = defaultLog,
): void {
  log.error(
    { reason, payload },
    'Dead-letter provider event: callback could not be processed',
  );
}
