/**
 * Session-source abstraction for CallController.
 *
 * CallController reads session state (conversation binding at construction,
 * lifecycle fields during the call) through a VoiceSessionSource rather than
 * directly from the call_sessions store. Phone calls use the store-backed
 * source below; non-phone voice sessions can inject a source that has no
 * call_sessions row at all.
 */

import { getCallSession } from "./call-store.js";
import type { CallStatus } from "./types.js";

/** Point-in-time view of the session lifecycle fields CallController reads. */
export interface VoiceSessionSnapshot {
  status: CallStatus;
  conversationId: string;
  initiatedFromConversationId: string | null;
  startedAt: number | null;
  toNumber: string;
}

export interface VoiceSessionSource {
  /** Conversation the voice session is bound to. */
  readonly conversationId: string;
  /** When true, the disclosure announcement is skipped for this call. */
  readonly skipDisclosure: boolean;
  /**
   * Current session lifecycle state, re-read on each call. Returns null when
   * the underlying session no longer exists (e.g. the row was deleted).
   */
  getSnapshot(): VoiceSessionSnapshot | null;
}

/** Store-backed source for phone calls: wraps getCallSession(callSessionId). */
export function createPhoneVoiceSessionSource(
  callSessionId: string,
): VoiceSessionSource {
  const session = getCallSession(callSessionId);
  return {
    conversationId: session?.conversationId ?? callSessionId,
    skipDisclosure: session?.skipDisclosure ?? false,
    getSnapshot(): VoiceSessionSnapshot | null {
      const current = getCallSession(callSessionId);
      if (!current) {
        return null;
      }
      return {
        status: current.status,
        conversationId: current.conversationId,
        initiatedFromConversationId:
          current.initiatedFromConversationId ?? null,
        startedAt: current.startedAt,
        toNumber: current.toNumber,
      };
    },
  };
}
