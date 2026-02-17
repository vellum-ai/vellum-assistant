import type * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { HandlerContext } from './handlers.js';
import type { RideShotgunStart } from './ipc-protocol.js';
import {
  watchSessions,
  registerWatchCompletionNotifier,
  unregisterWatchCompletionNotifier,
  fireWatchStartNotifier,
  fireWatchCompletionNotifier,
} from '../tools/watch/watch-state.js';
import type { WatchSession } from '../tools/watch/watch-state.js';
import { lastSummaryBySession, generateSummary } from './watch-handler.js';
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
  log.debug(
    { watchId, sessionId, durationSeconds, intervalSeconds },
    'Session created and stored in watchSessions map',
  );

  // Set timeout for duration expiry — generate summary before firing notifier
  session.timeoutHandle = setTimeout(async () => {
    session.status = 'completing';
    session.timeoutHandle = undefined;
    log.debug(
      { watchId, sessionId, observationCount: session.observations.length },
      'Duration timer fired — session completing. Generating summary...',
    );
    await generateSummary(session);
    session.status = 'completed';
    log.debug(
      { watchId, sessionId, hasSummary: lastSummaryBySession.has(sessionId) },
      'generateSummary returned — checking if completion notifier needs fallback fire',
    );
    // Fallback: if generateSummary failed or returned empty, fire notifier
    // anyway so the client always receives a response
    if (!lastSummaryBySession.has(sessionId)) {
      log.warn(
        { watchId, sessionId },
        'No summary in map — firing completion notifier as fallback (will send empty summary)',
      );
      fireWatchCompletionNotifier(sessionId, session);
    }
  }, durationSeconds * 1000);

  // Register completion notifier to send summary back to client
  registerWatchCompletionNotifier(sessionId, (_completedSession: WatchSession) => {
    const summary = lastSummaryBySession.get(sessionId) ?? '';
    const observationCount = _completedSession.observations.length;

    log.debug(
      { watchId, sessionId, observationCount, summaryLength: summary.length, socketDestroyed: socket.destroyed },
      'Completion notifier firing — sending ride_shotgun_result to client',
    );

    ctx.send(socket, {
      type: 'ride_shotgun_result',
      sessionId,
      watchId,
      summary,
      observationCount,
    });

    unregisterWatchCompletionNotifier(sessionId);
    lastSummaryBySession.delete(sessionId);
    log.debug({ watchId, sessionId, observationCount }, 'Ride shotgun result sent successfully');
  });

  // Fire start notifier
  fireWatchStartNotifier(sessionId, session);

  // Send watch_started so the Swift client knows the watchId/sessionId
  log.debug(
    { watchId, sessionId, socketDestroyed: socket.destroyed },
    'Sending watch_started to client',
  );
  ctx.send(socket, {
    type: 'watch_started',
    sessionId,
    watchId,
    durationSeconds,
    intervalSeconds,
  });

  log.debug({ watchId, sessionId, durationSeconds, intervalSeconds }, 'Ride shotgun session started — waiting for observations');
}
