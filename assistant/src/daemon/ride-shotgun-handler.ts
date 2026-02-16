import type * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { HandlerContext } from './handlers.js';
import type { RideShotgunStart } from './ipc-protocol.js';
import {
  watchSessions,
  registerWatchCompletionNotifier,
  unregisterWatchCompletionNotifier,
  fireWatchStartNotifier,
} from '../tools/watch/watch-state.js';
import type { WatchSession } from '../tools/watch/watch-state.js';
import { lastSummaryBySession } from './watch-handler.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('ride-shotgun-handler');

export async function handleRideShotgunStart(
  msg: RideShotgunStart,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const watchId = randomUUID();
  const sessionId = randomUUID();
  const { durationSeconds, intervalSeconds } = msg;

  const session: WatchSession = {
    watchId,
    sessionId,
    focusArea: 'General workflow observation',
    durationSeconds,
    intervalSeconds,
    observations: [],
    commentaryCount: 0,
    status: 'active',
    startedAt: Date.now(),
  };

  watchSessions.set(watchId, session);

  // Set timeout for duration expiry (same pattern as screen-watch.ts)
  session.timeoutHandle = setTimeout(() => {
    session.status = 'completing';
    session.timeoutHandle = undefined;
    log.info({ watchId }, 'Ride shotgun session duration expired, marking as completing');
  }, durationSeconds * 1000);

  // Register completion notifier to send summary back to client
  registerWatchCompletionNotifier(sessionId, (_completedSession: WatchSession) => {
    const summary = lastSummaryBySession.get(sessionId) ?? '';
    const observationCount = _completedSession.observations.length;

    ctx.send(socket, {
      type: 'ride_shotgun_result',
      sessionId,
      watchId,
      summary,
      observationCount,
    });

    unregisterWatchCompletionNotifier(sessionId);
    lastSummaryBySession.delete(sessionId);
    log.info({ watchId, sessionId, observationCount }, 'Ride shotgun result sent');
  });

  // Fire start notifier
  fireWatchStartNotifier(sessionId, session);

  // Send watch_started so the Swift client knows the watchId/sessionId
  ctx.send(socket, {
    type: 'watch_started',
    sessionId,
    watchId,
    durationSeconds,
    intervalSeconds,
  });

  log.info({ watchId, sessionId, durationSeconds, intervalSeconds }, 'Ride shotgun session started');
}
