/**
 * Call session notifiers and controller registry.
 *
 * Uses module-level Maps with register/unregister/fire helpers keyed by
 * conversationId.
 */

import { getLogger } from "../util/logger.js";
import type { CallController } from "./call-controller.js";

const log = getLogger("call-state");

// ── Question notifiers ──────────────────────────────────────────────
const questionNotifiers = new Map<
  string,
  (callSessionId: string, question: string) => void
>();

export function registerCallQuestionNotifier(
  conversationId: string,
  callback: (callSessionId: string, question: string) => void,
): void {
  questionNotifiers.set(conversationId, callback);
}

export function unregisterCallQuestionNotifier(conversationId: string): void {
  questionNotifiers.delete(conversationId);
}

export function fireCallQuestionNotifier(
  conversationId: string,
  callSessionId: string,
  question: string,
): void {
  questionNotifiers.get(conversationId)?.(callSessionId, question);
}

// ── Transcript notifiers ────────────────────────────────────────────
const transcriptNotifiers = new Map<
  string,
  (callSessionId: string, speaker: "caller" | "assistant", text: string) => void
>();

export function registerCallTranscriptNotifier(
  conversationId: string,
  callback: (
    callSessionId: string,
    speaker: "caller" | "assistant",
    text: string,
  ) => void,
): void {
  transcriptNotifiers.set(conversationId, callback);
}

export function unregisterCallTranscriptNotifier(conversationId: string): void {
  transcriptNotifiers.delete(conversationId);
}

export function fireCallTranscriptNotifier(
  conversationId: string,
  callSessionId: string,
  speaker: "caller" | "assistant",
  text: string,
): void {
  transcriptNotifiers.get(conversationId)?.(callSessionId, speaker, text);
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

export function fireCallCompletionNotifier(
  conversationId: string,
  callSessionId: string,
): void {
  completionNotifiers.get(conversationId)?.(callSessionId);
}

// ── Active controller registry ──────────────────────────────────────
const activeCallControllers = new Map<string, CallController>();

export function registerCallController(
  callSessionId: string,
  controller: CallController,
): void {
  activeCallControllers.set(callSessionId, controller);
  log.info({ callSessionId }, "Call controller registered");
}

export function unregisterCallController(callSessionId: string): void {
  activeCallControllers.delete(callSessionId);
  log.info({ callSessionId }, "Call controller unregistered");
}

export function getCallController(
  callSessionId: string,
): CallController | undefined {
  return activeCallControllers.get(callSessionId);
}
