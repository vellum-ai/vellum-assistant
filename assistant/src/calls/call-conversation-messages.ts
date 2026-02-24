/**
 * Persistence + formatting helpers for messages that belong in the
 * dedicated voice conversation thread.
 */

import * as conversationStore from '../memory/conversation-store.js';
import { getCallEvents, getCallSession } from './call-store.js';

export function buildCallCompletionMessage(callSessionId: string): string {
  const callSession = getCallSession(callSessionId);
  const events = getCallEvents(callSessionId);
  const duration = callSession?.endedAt && callSession?.startedAt
    ? Math.round((callSession.endedAt - callSession.startedAt) / 1000)
    : null;
  const durationStr = duration !== null ? ` (${duration}s)` : '';
  return `**Call completed**${durationStr}. ${events.length} event(s) recorded.`;
}

export function persistCallCompletionMessage(conversationId: string, callSessionId: string): string {
  const summaryText = buildCallCompletionMessage(callSessionId);
  conversationStore.addMessage(
    conversationId,
    'assistant',
    JSON.stringify([{ type: 'text', text: summaryText }]),
  );
  return summaryText;
}
