/**
 * Revocation sweep timer for A2A connections.
 *
 * Periodically retries sending revocation notifications for connections
 * in `revocation_pending` status. If delivery succeeds, transitions to
 * `revoked`. After max retry attempts, gives up and sets `revoked` anyway
 * (local enforcement was already applied at revocation time).
 */

import { listConnections, tombstoneOutboundCredential, updateConnectionStatus } from './a2a-peer-connection-store.js';
import { deliverRevocationNotification } from './a2a-revocation-delivery.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('a2a-revocation-sweep');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sweep interval: check every 5 minutes for pending revocations. */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Maximum number of delivery attempts before giving up and marking as
 * `revoked` anyway. Each sweep run is one attempt per connection.
 */
export const MAX_REVOCATION_ATTEMPTS = 10;

// ---------------------------------------------------------------------------
// In-memory attempt tracker
// ---------------------------------------------------------------------------

/**
 * Tracks the number of delivery attempts per connection. Keyed by
 * connection ID, value is the attempt count. Cleared when the connection
 * is successfully transitioned to `revoked`.
 */
const attemptCounts = new Map<string, number>();

/** Exposed for testing — reset attempt tracker. */
export function _resetAttemptCounts(): void {
  attemptCounts.clear();
}

/** Exposed for testing — get attempt count for a connection. */
export function _getAttemptCount(connectionId: string): number {
  return attemptCounts.get(connectionId) ?? 0;
}

// ---------------------------------------------------------------------------
// Sweep logic
// ---------------------------------------------------------------------------

/**
 * Run a single sweep: find all `revocation_pending` connections and
 * attempt to deliver revocation notifications. On success, transition
 * to `revoked`. After max attempts, force-transition to `revoked`.
 *
 * Returns the number of connections processed.
 */
export async function runRevocationSweep(): Promise<number> {
  const pendingConnections = listConnections({ status: 'revocation_pending' });

  if (pendingConnections.length === 0) {
    return 0;
  }

  log.info(
    { count: pendingConnections.length },
    'Revocation sweep: processing pending revocations',
  );

  let processed = 0;

  for (const connection of pendingConnections) {
    const attempts = (attemptCounts.get(connection.id) ?? 0) + 1;
    attemptCounts.set(connection.id, attempts);

    // If we've exceeded max attempts, give up and mark as revoked.
    // Tombstone the outbound credential since we're done retrying.
    if (attempts > MAX_REVOCATION_ATTEMPTS) {
      log.warn(
        { connectionId: connection.id, attempts },
        'Revocation sweep: max attempts exceeded, forcing revoked status',
      );
      tombstoneOutboundCredential(connection.id);
      updateConnectionStatus(connection.id, 'revoked', 'revocation_pending');
      attemptCounts.delete(connection.id);
      processed++;
      continue;
    }

    // The outbound credential is preserved on revocation_pending connections
    // so the sweep can sign retry delivery attempts.
    const result = await deliverRevocationNotification({
      connectionId: connection.id,
      peerGatewayUrl: connection.peerGatewayUrl,
      outboundCredential: connection.outboundCredential ?? '',
    });

    if (result.ok) {
      log.info(
        { connectionId: connection.id, attempts },
        'Revocation sweep: notification delivered, transitioning to revoked',
      );
      tombstoneOutboundCredential(connection.id);
      updateConnectionStatus(connection.id, 'revoked', 'revocation_pending');
      attemptCounts.delete(connection.id);
    } else if (result.reason === 'no_credential') {
      // No credential available — force revoked
      log.warn(
        { connectionId: connection.id },
        'Revocation sweep: no credential for signing, forcing revoked status',
      );
      updateConnectionStatus(connection.id, 'revoked', 'revocation_pending');
      attemptCounts.delete(connection.id);
    } else {
      log.warn(
        { connectionId: connection.id, attempts, error: result.error },
        'Revocation sweep: delivery failed, will retry on next sweep',
      );
    }

    processed++;
  }

  return processed;
}

// ---------------------------------------------------------------------------
// Timer lifecycle
// ---------------------------------------------------------------------------

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the revocation sweep timer. Idempotent — calling when already
 * running is a no-op.
 */
export function startRevocationSweep(): void {
  if (sweepTimer) return;

  sweepTimer = setInterval(() => {
    void runRevocationSweep().catch((err) => {
      log.error({ err }, 'Revocation sweep failed');
    });
  }, SWEEP_INTERVAL_MS);

  log.info({ intervalMs: SWEEP_INTERVAL_MS }, 'Revocation sweep timer started');
}

/**
 * Stop the revocation sweep timer. Idempotent.
 */
export function stopRevocationSweep(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
  log.info('Revocation sweep timer stopped');
}
