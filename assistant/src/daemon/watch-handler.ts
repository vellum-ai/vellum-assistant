import type * as net from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { getLogger } from '../util/logger.js';
import type { WatchObservation } from './ipc-protocol.js';
import type { HandlerContext } from './handlers.js';
import {
  watchSessions,
  addObservation,
  fireWatchCommentaryNotifier,
  fireWatchCompletionNotifier,
} from '../tools/watch/watch-state.js';
import type { WatchSession, WatchObservationEntry } from '../tools/watch/watch-state.js';

const log = getLogger('watch-handler');

/**
 * Module-level maps to store commentary/summary text so that session
 * notifier callbacks can retrieve it from the WatchSession's sessionId.
 */
export const lastCommentaryBySession = new Map<string, string>();
export const lastSummaryBySession = new Map<string, string>();

export async function handleWatchObservation(
  msg: WatchObservation,
  _socket: net.Socket,
  _ctx: HandlerContext,
): Promise<void> {
  try {
    // 1. Find the WatchSession by watchId
    const session = watchSessions.get(msg.watchId);

    // 2. If not found or not active (and not completing), log warning and return
    if (!session) {
      log.warn({ watchId: msg.watchId }, 'Watch session not found for observation');
      return;
    }
    if (session.status !== 'active' && session.status !== 'completing') {
      log.warn({ watchId: msg.watchId, status: session.status }, 'Watch session not active');
      return;
    }

    // 3. Create a WatchObservationEntry and add it
    const entry: WatchObservationEntry = {
      ocrText: msg.ocrText,
      appName: msg.appName,
      windowTitle: msg.windowTitle,
      bundleIdentifier: msg.bundleIdentifier,
      timestamp: msg.timestamp,
      captureIndex: msg.captureIndex,
    };
    addObservation(msg.watchId, entry);

    // 4. Every 3 observations: call Haiku for live commentary
    if (session.observations.length % 3 === 0) {
      await generateCommentary(session);
    }

    // 5. If session is completing, generate final summary
    if (session.status === 'completing') {
      await generateSummary(session);
    }
  } catch (err) {
    log.error({ err, watchId: msg.watchId }, 'Error handling watch observation');
  }
}

async function generateCommentary(session: WatchSession): Promise<void> {
  try {
    const client = new Anthropic();
    const lastThree = session.observations.slice(-3);
    const userContent = lastThree
      .map(
        (obs, i) =>
          `Observation ${i + 1}:\n- App: ${obs.appName ?? 'unknown'}\n- Text: ${obs.ocrText}`,
      )
      .join('\n\n');

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system:
        'You are observing someone\'s screen. Give a brief 1-2 sentence commentary on what you see, or respond with SKIP if nothing interesting.',
      messages: [{ role: 'user', content: userContent }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const commentaryText =
      textBlock && 'text' in textBlock ? textBlock.text.trim() : '';

    if (commentaryText && commentaryText !== 'SKIP') {
      lastCommentaryBySession.set(session.sessionId, commentaryText);
      fireWatchCommentaryNotifier(session.sessionId, session);
      session.commentaryCount++;
    }
  } catch (err) {
    log.error({ err, watchId: session.watchId }, 'Error generating watch commentary');
  }
}

async function generateSummary(session: WatchSession): Promise<void> {
  try {
    const client = new Anthropic();

    // Build observations text with truncation
    let observations = session.observations;
    let totalChars = observations.reduce((sum, obs) => sum + obs.ocrText.length, 0);

    if (totalChars > 50_000) {
      // Trim older observations, keeping most recent
      const trimmed: WatchObservationEntry[] = [];
      let charCount = 0;
      for (let i = observations.length - 1; i >= 0; i--) {
        charCount += observations[i].ocrText.length;
        if (charCount > 50_000) break;
        trimmed.unshift(observations[i]);
      }
      observations = trimmed;
    }

    const userContent = observations
      .map(
        (obs) =>
          `[${new Date(obs.timestamp).toISOString()}] App: ${obs.appName ?? 'unknown'}\n${obs.ocrText}`,
      )
      .join('\n\n---\n\n');

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2000,
      system: 'Summarize the user\'s workflow based on screen observations.',
      messages: [{ role: 'user', content: userContent }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const summaryText =
      textBlock && 'text' in textBlock ? textBlock.text.trim() : '';

    if (summaryText) {
      lastSummaryBySession.set(session.sessionId, summaryText);
      fireWatchCompletionNotifier(session.sessionId, session);
      session.status = 'completed';
    }
  } catch (err) {
    log.error({ err, watchId: session.watchId }, 'Error generating watch summary');
  }
}
