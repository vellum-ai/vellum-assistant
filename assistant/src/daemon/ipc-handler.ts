/**
 * IPC wire-level helpers: socket writing, broadcast, and assistant-event
 * hub publishing. Extracted from DaemonServer to separate transport
 * concerns from session management and business logic.
 */
import * as net from 'node:net';

import { buildAssistantEvent } from '../runtime/assistant-event.js';
import { assistantEventHub } from '../runtime/assistant-event-hub.js';
import { DAEMON_INTERNAL_ASSISTANT_ID } from '../runtime/assistant-scope.js';
import { CURRENT_POLICY_EPOCH } from '../runtime/auth/policy.js';
import { resolveScopeProfile } from '../runtime/auth/scopes.js';
import type { AuthContext } from '../runtime/auth/types.js';
import { getLogger } from '../util/logger.js';
import { serialize, type ServerMessage } from './ipc-protocol.js';

const log = getLogger('ipc-handler');

/**
 * Manages IPC message delivery: writing to individual sockets,
 * broadcasting to all authenticated sockets, and publishing events
 * to the assistant-events hub in order.
 */
export class IpcSender {
  private _hubChain: Promise<void> = Promise.resolve();

  /** Write to a single socket without publishing to the event hub. */
  writeToSocket(socket: net.Socket, msg: ServerMessage): void {
    if (!socket.destroyed && socket.writable) {
      socket.write(serialize(msg));
    }
  }

  /**
   * Send a message to a single socket and publish to the event hub.
   * `sessionId` is resolved from the message itself or the socket binding.
   */
  send(
    socket: net.Socket,
    msg: ServerMessage,
    socketToSession: Map<net.Socket, string>,
    assistantId: string,
  ): void {
    this.writeToSocket(socket, msg);
    const sessionId = extractSessionId(msg) ?? socketToSession.get(socket);
    this.publishAssistantEvent(msg, sessionId, assistantId);
  }

  /**
   * Broadcast a message to all authenticated sockets, then publish
   * a single event to the hub.
   */
  broadcast(
    authenticatedSockets: Set<net.Socket>,
    msg: ServerMessage,
    socketToSession: Map<net.Socket, string>,
    assistantId: string,
    excludeSocket?: net.Socket,
  ): void {
    for (const socket of authenticatedSockets) {
      if (socket === excludeSocket) continue;
      this.writeToSocket(socket, msg);
    }
    const sessionId = extractSessionId(msg)
      ?? (excludeSocket ? socketToSession.get(excludeSocket) : undefined);
    this.publishAssistantEvent(msg, sessionId, assistantId);
  }

  /**
   * Publish `msg` as an `AssistantEvent` to the process-level hub.
   * Publications are serialized via a promise chain so subscribers
   * always observe events in send order.
   */
  private publishAssistantEvent(msg: ServerMessage, sessionId?: string, assistantId?: string): void {
    const id = assistantId ?? 'default';
    const event = buildAssistantEvent(id, msg, sessionId);
    this._hubChain = this._hubChain
      .then(() => assistantEventHub.publish(event))
      .catch((err: unknown) => {
        log.warn({ err }, 'assistant-events hub subscriber threw during IPC send');
      });
  }
}

/**
 * Build a synthetic AuthContext for an IPC session.
 *
 * IPC connections are local-only (Unix domain socket) and pre-authenticated
 * via the daemon's file-system permission model. This produces the same
 * AuthContext shape that HTTP routes receive from JWT verification, keeping
 * downstream code transport-agnostic.
 */
export function buildIpcAuthContext(sessionId: string): AuthContext {
  return {
    subject: `ipc:self:${sessionId}`,
    principalType: 'ipc',
    assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    sessionId,
    scopeProfile: 'ipc_v1',
    scopes: resolveScopeProfile('ipc_v1'),
    policyEpoch: CURRENT_POLICY_EPOCH,
  };
}

/** Extract sessionId from a ServerMessage if present. */
function extractSessionId(msg: ServerMessage): string | undefined {
  const record = msg as unknown as Record<string, unknown>;
  if ('sessionId' in msg && typeof record.sessionId === 'string') {
    return record.sessionId as string;
  }
  return undefined;
}
