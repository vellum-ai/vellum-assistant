import type * as net from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config/loader.js';
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
    log.info(
      { watchId: msg.watchId, captureIndex: msg.captureIndex, appName: msg.appName, ocrLen: msg.ocrText?.length ?? 0 },
      '[SHOTGUN-DEBUG] Received watch_observation from client',
    );

    // 1. Find the WatchSession by watchId
    const session = watchSessions.get(msg.watchId);

    // 2. If not found or not active (and not completing), log warning and return
    if (!session) {
      log.warn(
        { watchId: msg.watchId, knownWatchIds: [...watchSessions.keys()] },
        '[SHOTGUN-DEBUG] Watch session not found for observation — known watchIds listed',
      );
      return;
    }
    if (session.status !== 'active' && session.status !== 'completing') {
      log.warn({ watchId: msg.watchId, status: session.status }, '[SHOTGUN-DEBUG] Watch session not active');
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
    log.info(
      { watchId: msg.watchId, totalObservations: session.observations.length, status: session.status },
      '[SHOTGUN-DEBUG] Observation added to session',
    );

    // 4. Every 3 observations: call Haiku for live commentary
    if (session.observations.length % 3 === 0) {
      log.info(
        { watchId: msg.watchId, observationCount: session.observations.length },
        '[SHOTGUN-DEBUG] Triggering commentary generation (every 3rd observation)',
      );
      await generateCommentary(session);
    }

    // 5. If session is completing, generate final summary
    if (session.status === 'completing') {
      log.info({ watchId: msg.watchId }, '[SHOTGUN-DEBUG] Session is completing — generating summary from observation handler');
      session.status = 'completed';
      await generateSummary(session);
    }
  } catch (err) {
    log.error({ err, watchId: msg.watchId }, '[SHOTGUN-DEBUG] Error handling watch observation');
  }
}

async function generateCommentary(session: WatchSession): Promise<void> {
  try {
    log.info({ watchId: session.watchId, sessionId: session.sessionId }, '[SHOTGUN-DEBUG] generateCommentary starting — calling Haiku');
    const apiKey = getConfig().apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      log.warn({ watchId: session.watchId }, '[SHOTGUN-DEBUG] No Anthropic API key available for commentary generation');
      return;
    }
    const client = new Anthropic({ apiKey });
    const lastThree = session.observations.slice(-3);

    const previousCommentary = lastCommentaryBySession.get(session.sessionId);

    const userContent = [
      `Focus area: ${session.focusArea}`,
      '',
      previousCommentary
        ? `Previous commentary: "${previousCommentary}"`
        : 'No previous commentary yet.',
      '',
      ...lastThree.map(
        (obs, i) =>
          `Observation ${i + 1}:\n- App: ${obs.appName ?? 'unknown'}\n- Window: ${obs.windowTitle ?? 'unknown'}\n- Screen text: ${obs.ocrText}`,
      ),
    ].join('\n\n');

    const systemPrompt = [
      'You are a casual, friendly observer watching someone work on their computer in real time.',
      `They asked you to watch them and focus on: "${session.focusArea}".`,
      '',
      'Your job is to provide brief, natural live commentary — like a friend glancing over their shoulder.',
      '',
      'Guidelines:',
      '- Write 1-2 sentences max. Be concise and conversational.',
      '- Comment on what they are doing, patterns you notice, or interesting transitions.',
      '- Reference specific apps or content you see when relevant.',
      '- If they seem to be context-switching a lot, gently note it.',
      '- Do NOT repeat your previous commentary. Say something new or say nothing.',
      '- If nothing interesting or meaningfully different has happened since the last observations, respond with exactly "SKIP" (no quotes, no extra text).',
      '',
      'Example style:',
      '"I see you\'ve been bouncing between Slack and your doc — looks like you\'re getting pulled into side conversations."',
      '"You\'ve been heads-down in VS Code for a while now, nice focused stretch."',
      '"Looks like you just switched to the browser to look something up mid-task."',
    ].join('\n');

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });

    log.info({ watchId: session.watchId }, '[SHOTGUN-DEBUG] Haiku API call completed successfully');

    const textBlock = response.content.find((b) => b.type === 'text');
    const commentaryText =
      textBlock && 'text' in textBlock ? textBlock.text.trim() : '';

    log.info(
      { watchId: session.watchId, commentaryText: commentaryText.substring(0, 100), isSkip: commentaryText === 'SKIP' },
      '[SHOTGUN-DEBUG] Commentary result from Haiku',
    );

    if (commentaryText && commentaryText !== 'SKIP') {
      lastCommentaryBySession.set(session.sessionId, commentaryText);
      fireWatchCommentaryNotifier(session.sessionId, session);
      session.commentaryCount++;
      log.info(
        { watchId: session.watchId, commentaryCount: session.commentaryCount },
        '[SHOTGUN-DEBUG] Commentary notifier fired',
      );
    } else {
      log.info({ watchId: session.watchId }, '[SHOTGUN-DEBUG] Commentary skipped (empty or SKIP)');
    }
  } catch (err) {
    log.error({ err, watchId: session.watchId }, '[SHOTGUN-DEBUG] Error generating watch commentary — API call failed');
  }
}

export async function generateSummary(session: WatchSession): Promise<void> {
  try {
    log.info(
      { watchId: session.watchId, sessionId: session.sessionId, observationCount: session.observations.length, commentaryCount: session.commentaryCount },
      '[SHOTGUN-DEBUG] generateSummary starting — calling Sonnet',
    );
    const apiKey = getConfig().apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      log.warn({ watchId: session.watchId }, '[SHOTGUN-DEBUG] No Anthropic API key available for summary generation');
      return;
    }
    const client = new Anthropic({ apiKey });

    // Build observations text with truncation (keep most recent if >50K chars)
    let observations = session.observations;
    const totalChars = observations.reduce((sum, obs) => sum + obs.ocrText.length, 0);
    let wasTruncated = false;

    if (totalChars > 50_000) {
      const trimmed: WatchObservationEntry[] = [];
      let charCount = 0;
      for (let i = observations.length - 1; i >= 0; i--) {
        charCount += observations[i].ocrText.length;
        if (charCount > 50_000) break;
        trimmed.unshift(observations[i]);
      }
      wasTruncated = trimmed.length < observations.length;
      observations = trimmed;
    }

    const elapsedMinutes = Math.round(
      (Date.now() - session.startedAt) / 60_000,
    );
    const expectedMinutes = Math.round(session.durationSeconds / 60);
    const wasCancelled = elapsedMinutes < expectedMinutes - 1;

    const userContent = [
      `Focus area: ${session.focusArea}`,
      `Observation period: ${elapsedMinutes} minute(s) (planned: ${expectedMinutes} minute(s))`,
      `Total observations: ${session.observations.length}`,
      ...(wasTruncated
        ? [`Note: Older observations were trimmed due to size. Showing the most recent ${observations.length} of ${session.observations.length} total.`]
        : []),
      ...(wasCancelled
        ? ['Note: The observation period was ended early by the user. Provide your best analysis based on the data available.']
        : []),
      '',
      '--- Observations ---',
      '',
      ...observations.map(
        (obs) =>
          `[${new Date(obs.timestamp).toISOString()}] App: ${obs.appName ?? 'unknown'} | Window: ${obs.windowTitle ?? 'unknown'}\n${obs.ocrText}`,
      ),
    ].join('\n\n');

    const systemPrompt = [
      'You are a productivity analyst reviewing a series of screen observations captured from a user\'s computer.',
      `The user asked you to watch their workflow with this focus: "${session.focusArea}".`,
      '',
      'Analyze the observations and produce a structured report using exactly these markdown sections:',
      '',
      '## Workflow Summary',
      'A high-level description (2-4 sentences) of what the user did during the observation period.',
      '',
      '## App Usage',
      'List which applications were used and roughly how much time was spent in each. Use the timestamps to estimate durations. Present as a bullet list.',
      '',
      '## Context Switching',
      'Analyze how often the user switched between different apps or tasks. Note any patterns — were switches frequent and disruptive, or natural and purposeful?',
      '',
      '## Tasks & Action Items',
      'Based on what you observed on screen, describe what tasks the user worked on. Note anything that appeared unfinished or in-progress when the session ended.',
      '',
      '## Suggestions',
      'Provide 3-5 specific, actionable things the assistant could help with based on what you observed. These should be concrete offers, not generic advice.',
      'Examples: "I could draft that email you started in Gmail", "Want me to summarize the Slack thread you were reading?", "I could help outline the document you were working on in Google Docs".',
      '',
      'Important:',
      '- Base your analysis strictly on what you can see in the observations. Do not invent details.',
      '- Reference specific apps, window titles, and content when possible.',
      '- Keep the tone helpful and professional, not judgmental.',
      ...(wasCancelled
        ? ['- The observation period was cut short. Acknowledge this briefly and provide the best analysis you can with the available data.']
        : []),
    ].join('\n');

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });

    log.info({ watchId: session.watchId }, '[SHOTGUN-DEBUG] Sonnet API call completed successfully');

    const textBlock = response.content.find((b) => b.type === 'text');
    const summaryText =
      textBlock && 'text' in textBlock ? textBlock.text.trim() : '';

    log.info(
      { watchId: session.watchId, summaryLength: summaryText.length, summaryPreview: summaryText.substring(0, 150) },
      '[SHOTGUN-DEBUG] Summary result from Sonnet',
    );

    if (summaryText) {
      lastSummaryBySession.set(session.sessionId, summaryText);
      log.info({ watchId: session.watchId, sessionId: session.sessionId }, '[SHOTGUN-DEBUG] Firing completion notifier with summary');
      fireWatchCompletionNotifier(session.sessionId, session);
    } else {
      log.warn({ watchId: session.watchId }, '[SHOTGUN-DEBUG] Summary was empty — completion notifier NOT fired');
    }
  } catch (err) {
    log.error({ err, watchId: session.watchId }, '[SHOTGUN-DEBUG] Error generating watch summary — Sonnet API call failed');
  }
}
