/**
 * Transport interface consumed by CallController for sending voice output
 * and controlling call lifecycle.
 *
 * Decouples the controller from any specific wire protocol (e.g.
 * ConversationRelay) so that alternative transports (media-stream, etc.)
 * can be introduced without modifying controller logic.
 */

// ── Transport interface ──────────────────────────────────────────────

/**
 * Minimal output surface that CallController uses to send speech,
 * audio, and lifecycle signals to the caller.
 */
export interface CallTransport {
  /**
   * Send a text token for TTS playback. When `last` is true the
   * transport should signal end-of-turn to the caller.
   */
  sendTextToken(token: string, last: boolean): void;

  /**
   * Send a pre-synthesized audio URL for playback.
   */
  sendPlayUrl(url: string): void;

  /**
   * Signal the transport to end the call session.
   */
  endSession(reason?: string): void;

  /**
   * Return the current connection-level state. The controller uses this
   * to suppress silence nudges during guardian wait states.
   */
  getConnectionState(): string;
}

// ── ConversationRelay adapter ────────────────────────────────────────

import type { RelayConnection } from "./relay-server.js";

/**
 * Adapts a RelayConnection (Twilio ConversationRelay WebSocket) to the
 * CallTransport interface. All calls are forwarded 1:1 — no behavioral
 * changes from the pre-abstraction path.
 */
export class ConversationRelayTransport implements CallTransport {
  constructor(private relay: RelayConnection) {}

  sendTextToken(token: string, last: boolean): void {
    this.relay.sendTextToken(token, last);
  }

  sendPlayUrl(url: string): void {
    this.relay.sendPlayUrl(url);
  }

  endSession(reason?: string): void {
    this.relay.endSession(reason);
  }

  getConnectionState(): string {
    return this.relay.getConnectionState();
  }
}
