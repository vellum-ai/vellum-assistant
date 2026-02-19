/**
 * Call session notifiers and orchestrator registry.
 *
 * Follows the same notifier pattern as watch-state.ts: module-level Maps
 * with register/unregister/fire helpers keyed by conversationId.
 */

import { getLogger } from '../util/logger.js';
import type { CallOrchestrator } from './call-orchestrator.js';

const log = getLogger('call-state');

// ── Question notifiers ──────────────────────────────────────────────
const questionNotifiers = new Map<string, (callSessionId: string, question: string) => void>();

export function registerCallQuestionNotifier(
  conversationId: string,
  callback: (callSessionId: string, question: string) => void,
): void {
  questionNotifiers.set(conversationId, callback);
}

export function unregisterCallQuestionNotifier(conversationId: string): void {
  questionNotifiers.delete(conversationId);
}

export function fireCallQuestionNotifier(conversationId: string, callSessionId: string, question: string): void {
  questionNotifiers.get(conversationId)?.(callSessionId, question);
}

// ── Completion notifiers ────────────────────────────────────────────
const completionNotifiers = new Map<string, (callSessionId: string) => void>();

export function registerCallCompletionNotifier(
  conversationId: string,
  callback: (callSessionId: string) => void,
): void {
  completionNotifiers.set(conversationId, callback);
}

export function unregisterCallCompletionNotifier(conversationId: string): void {
  completionNotifiers.delete(conversationId);
}

export function fireCallCompletionNotifier(conversationId: string, callSessionId: string): void {
  completionNotifiers.get(conversationId)?.(callSessionId);
}

// ── Active orchestrator registry ────────────────────────────────────
const activeCallOrchestrators = new Map<string, CallOrchestrator>();

export function registerCallOrchestrator(callSessionId: string, orchestrator: CallOrchestrator): void {
  activeCallOrchestrators.set(callSessionId, orchestrator);
  log.info({ callSessionId }, 'Call orchestrator registered');
}

export function unregisterCallOrchestrator(callSessionId: string): void {
  activeCallOrchestrators.delete(callSessionId);
  log.info({ callSessionId }, 'Call orchestrator unregistered');
}

export function getCallOrchestrator(callSessionId: string): CallOrchestrator | undefined {
  return activeCallOrchestrators.get(callSessionId);
}
